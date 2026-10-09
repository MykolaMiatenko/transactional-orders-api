import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import amqp, { type ChannelModel, type ConfirmChannel, type Message, type Options } from "amqplib";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { OrderEvent } from "./contracts.js";
import { consumeEvent } from "./consumer.js";
import type { EventPublisher } from "./outbox.js";

export function rabbitTopology(prefix = "orders") {
  return { exchange: `${prefix}.events`, queue: `${prefix}.projection`, deadQueue: `${prefix}.projection.dead` };
}
export type RabbitTopology = ReturnType<typeof rabbitTopology>;

export async function openRabbit(url: string, topology: RabbitTopology): Promise<{ connection: ChannelModel; channel: ConfirmChannel }> {
  const connection = await amqp.connect(url, { timeout: 3000 });
  // Callers monitor close events and reconnect; never emit raw broker errors containing credentials.
  connection.on("error", () => {});
  try {
    const channel = await connection.createConfirmChannel();
    channel.on("error", () => {});
    await channel.assertExchange(topology.exchange, "direct", { durable: true });
    await channel.assertQueue(topology.queue, { durable: true, arguments: { "x-queue-type": "quorum" } });
    await channel.bindQueue(topology.queue, topology.exchange, "order");
    await channel.assertQueue(topology.deadQueue, { durable: true, arguments: { "x-queue-type": "quorum" } });
    return { connection, channel };
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string,
  content: Buffer, options: Options.Publish, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const messageId = options.messageId ?? randomUUID();
    let returned = false;
    let settled = false;
    const onReturn = (message: Message) => { if (message.properties.messageId === messageId) returned = true; };
    const onClose = () => finish(new Error("Broker channel closed before confirmation"));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.off("return", onReturn);
      channel.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error("Broker confirmation timed out"));
      void channel.close().catch(() => {});
    }, timeoutMs);
    channel.on("return", onReturn);
    channel.on("close", onClose);
    try {
      channel.publish(exchange, routingKey, content, { ...options, messageId, persistent: true, mandatory: true },
        (error: unknown) => finish(error ? new Error("Broker rejected publication") : returned ? new Error("Message was not routed") : undefined));
    } catch {
      finish(new Error("Broker publication failed"));
    }
  });
}

export function rabbitPublisher(channel: ConfirmChannel, topology: RabbitTopology, timeoutMs: number): EventPublisher {
  return { publish: (event: OrderEvent) => publishConfirmed(channel, topology.exchange, "order", Buffer.from(JSON.stringify(event)),
    { messageId: event.eventId, contentType: "application/json", type: event.type }, timeoutMs) };
}

export async function handleDelivery(pool: Pool, channel: ConfirmChannel, topology: RabbitTopology, message: Message,
  settings: { maxAttempts: number; confirmTimeoutMs: number; retryDelayMs: number }, logger: Logger): Promise<void> {
  let failure: unknown;
  try {
    await consumeEvent(pool, JSON.parse(message.content.toString("utf8")));
  } catch (error) { failure = error; }
  if (!failure) { channel.ack(message); return; }
  const previous = message.properties.headers?.retryCount;
  const attempts = typeof previous === "number" && Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  const permanent = failure instanceof SyntaxError || failure instanceof ZodError;
  const dead = permanent || attempts >= settings.maxAttempts;
  logger.warn({ messageId: message.properties.messageId, attempts, dead }, "Consumer delivery failed");
  if (!dead) await delay(Math.min(settings.retryDelayMs * 2 ** (attempts - 1), 30_000));
  // Confirm the replacement before acknowledging the original. A crash can duplicate, never drop it.
  await publishConfirmed(channel, dead ? "" : topology.exchange, dead ? topology.deadQueue : "order", message.content,
    { messageId: message.properties.messageId ?? randomUUID(), contentType: "application/json", headers: { retryCount: attempts } }, settings.confirmTimeoutMs);
  channel.ack(message);
}

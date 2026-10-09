import { setTimeout as delay } from "node:timers/promises";
import { pino } from "pino";
import { loadConfig } from "../config.js";
import { createPool } from "../database.js";
import { dispatchOnce } from "./outbox.js";
import { handleDelivery, openRabbit, rabbitPublisher, rabbitTopology } from "./rabbit.js";

export async function runEventProcess(mode: "worker" | "consumer"): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const pool = createPool(config, logger);
  const topology = rabbitTopology();
  const stop = new AbortController();
  let deadline: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const pause = (ms: number) => delay(ms, undefined, { signal: stop.signal }).catch(() => {});
  try {
    await pool.query("SELECT 1 FROM outbox_events LIMIT 0");
    while (!stop.signal.aborted) {
      let rabbit: Awaited<ReturnType<typeof openRabbit>> | undefined;
      try {
        rabbit = await openRabbit(config.AMQP_URL, topology);
        let disconnected = false;
        rabbit.connection.on("close", () => { disconnected = true; });
        rabbit.channel.on("close", () => { disconnected = true; });
        logger.info({ mode }, "Event process connected");
        if (mode === "worker") {
          const publisher = rabbitPublisher(rabbit.channel, topology, config.AMQP_CONFIRM_TIMEOUT_MS);
          while (!stop.signal.aborted && !disconnected) {
            const result = await dispatchOnce(pool, publisher, { leaseMs: config.OUTBOX_LEASE_MS,
              maxAttempts: config.OUTBOX_MAX_ATTEMPTS, backoffMs: config.OUTBOX_BACKOFF_MS });
            if (result === "retry") logger.warn("Outbox delivery scheduled for retry or marked failed");
            if (result !== "published") await pause(config.OUTBOX_POLL_MS);
          }
        } else {
          const channel = rabbit.channel;
          await channel.prefetch(1);
          let active: Promise<void> | undefined;
          const { consumerTag } = await channel.consume(topology.queue, (message) => {
            if (!message) { disconnected = true; return; }
            active = handleDelivery(pool, channel, topology, message, { maxAttempts: config.CONSUMER_MAX_ATTEMPTS,
              confirmTimeoutMs: config.AMQP_CONFIRM_TIMEOUT_MS, retryDelayMs: config.OUTBOX_BACKOFF_MS }, logger)
              .catch(() => {
                // Closing the channel requeues any unacknowledged original delivery.
                logger.warn("Consumer channel failed; unacknowledged messages will be redelivered");
                disconnected = true;
                void channel.close().catch(() => {});
              });
          });
          while (!stop.signal.aborted && !disconnected) await pause(250);
          await channel.cancel(consumerTag).catch(() => {});
          await active;
        }
      } catch {
        logger.warn({ mode }, "Event process unavailable; reconnecting");
      } finally {
        if (rabbit) {
          await rabbit.channel.close().catch(() => {});
          await rabbit.connection.close().catch(() => {});
        }
      }
      if (!stop.signal.aborted) await pause(config.OUTBOX_POLL_MS);
    }
  } finally {
    await pool.end();
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    if (deadline) clearTimeout(deadline);
  }
}

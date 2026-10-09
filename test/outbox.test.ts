import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { pino } from "pino";
import { consumeEvent } from "../src/events/consumer.js";
import { claimEvent, completeEvent, dispatchOnce, retryEvent, type DispatchSettings } from "../src/events/outbox.js";
import { handleDelivery, openRabbit, publishConfirmed, rabbitPublisher, rabbitTopology } from "../src/events/rabbit.js";
import { migrate } from "../src/migrate.js";
import { OrderService } from "../src/orders/service.js";
import type { OrderEvent } from "../src/events/contracts.js";

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_AMQP_URL) throw new Error("Set TEST_DATABASE_URL and TEST_AMQP_URL to dedicated test services.");
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, options: `-c search_path=${schema}` });
const service = new OrderService(pool);
const topology = rabbitTopology(schema);
const settings: DispatchSettings = { leaseMs: 1000, maxAttempts: 3, backoffMs: 0 };
const consumerSettings = { maxAttempts: 2, confirmTimeoutMs: 3000, retryDelayMs: 1 };
const logger = pino({ level: "silent" });
const productId = "7106f556-b21c-4a1f-b155-44327735deae";
let rabbit: Awaited<ReturnType<typeof openRabbit>>;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  rabbit = await openRabbit(process.env.TEST_AMQP_URL!, topology);
});
beforeEach(async () => {
  await pool.query("TRUNCATE consumed_events, order_projections, outbox_events, idempotency_requests, orders, products");
  await pool.query("INSERT INTO products (id, price_cents, stock) VALUES ($1, 1999, 100)", [productId]);
  await rabbit.channel.purgeQueue(topology.queue);
  await rabbit.channel.purgeQueue(topology.deadQueue);
});
after(async () => {
  if (rabbit) {
    await rabbit.channel.deleteQueue(topology.queue);
    await rabbit.channel.deleteQueue(topology.deadQueue);
    await rabbit.channel.deleteExchange(topology.exchange);
    await rabbit.channel.close();
    await rabbit.connection.close();
  }
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
});
const create = () => service.create("user", randomUUID(), { productId, quantity: 2 });
async function message(queue = topology.queue) {
  const until = Date.now() + 3000;
  do {
    const result = await rabbit.channel.get(queue, { noAck: false });
    if (result) return result;
    await delay(20);
  } while (Date.now() < until);
  throw new Error("Expected broker message was not received");
}
async function events(): Promise<OrderEvent[]> {
  return (await pool.query<{ payload: OrderEvent }>("SELECT payload FROM outbox_events ORDER BY sequence")).rows.map((row) => row.payload);
}

test("business operations and events commit together, including idempotent repeats", async () => {
  const key = randomUUID();
  const order = await service.create("user", key, { productId, quantity: 2 });
  await service.create("user", key, { productId, quantity: 2 });
  await service.cancel("user", order.id);
  await service.cancel("user", order.id);
  assert.deepEqual((await events()).map((event) => event.type), ["OrderCreated", "OrderCancelled"]);
  await pool.query("ALTER TABLE outbox_events ADD CONSTRAINT simulated_event_failure CHECK (event_type <> 'OrderCreated') NOT VALID");
  try {
    await assert.rejects(create());
    assert.equal((await pool.query("SELECT stock FROM products")).rows[0]?.stock, 100);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM orders")).rows[0]?.count, 1);
    assert.equal((await events()).length, 2);
  } finally { await pool.query("ALTER TABLE outbox_events DROP CONSTRAINT simulated_event_failure"); }
});

test("concurrent workers publish each claim once and preserve aggregate order", async () => {
  const order = await create();
  await service.cancel("user", order.id);
  const created = await claimEvent(pool, settings);
  assert.ok(created);
  assert.equal(await claimEvent(pool, settings), undefined);
  await completeEvent(pool, created);
  const cancelled = await claimEvent(pool, settings);
  assert.equal(cancelled?.payload.type, "OrderCancelled");
  await completeEvent(pool, cancelled!);
  await Promise.all(Array.from({ length: 4 }, create));
  const seen: string[] = [];
  const results = await Promise.all(Array.from({ length: 8 }, () => dispatchOnce(pool, {
    publish: async (event) => { seen.push(event.eventId); await delay(10); },
  }, settings)));
  assert.equal(results.filter((result) => result === "published").length, 4);
  assert.equal(new Set(seen).size, 4);
});

test("broker outage schedules backoff and final failures block later aggregate events", async () => {
  const order = await create();
  await service.cancel("user", order.id);
  const broken = { publish: async () => { throw new Error("Broker unavailable"); } };
  assert.equal(await dispatchOnce(pool, broken, { ...settings, backoffMs: 1000 }), "retry");
  assert.equal(await claimEvent(pool, settings), undefined);
  await pool.query("UPDATE outbox_events SET available_at = now() WHERE status = 'pending'");
  assert.equal(await dispatchOnce(pool, broken, settings), "retry");
  assert.equal(await dispatchOnce(pool, broken, settings), "retry");
  const rows = (await pool.query("SELECT status, attempts FROM outbox_events ORDER BY sequence")).rows;
  assert.deepEqual(rows, [{ status: "failed", attempts: 3 }, { status: "pending", attempts: 0 }]);
  assert.equal(await claimEvent(pool, settings), undefined);
});

test("expired final leases become failures and stale workers cannot acknowledge a reclaimed claim", async () => {
  await create();
  const first = (await claimEvent(pool, settings))!;
  await pool.query("UPDATE outbox_events SET locked_until = now() - interval '1 second'");
  const second = (await claimEvent(pool, settings))!;
  assert.equal(second.eventId, first.eventId);
  assert.notEqual(second.lockToken, first.lockToken);
  assert.equal(await completeEvent(pool, first), false);
  await retryEvent(pool, first, settings);
  await pool.query("UPDATE outbox_events SET attempts = 3, locked_until = now() - interval '1 second'");
  assert.equal(await claimEvent(pool, settings), undefined);
  assert.equal((await pool.query("SELECT status FROM outbox_events")).rows[0]?.status, "failed");
});

test("real RabbitMQ confirms deliveries and consumer deduplicates a crash-after-publish retry", async () => {
  await create();
  const publisher = rabbitPublisher(rabbit.channel, topology, 3000);
  const first = (await claimEvent(pool, settings))!;
  await publisher.publish(first.payload);
  // Simulate death after broker confirmation but before marking the outbox event published.
  await pool.query("UPDATE outbox_events SET locked_until = now() - interval '1 second'");
  assert.equal(await dispatchOnce(pool, publisher, settings), "published");
  assert.equal(await completeEvent(pool, first), false);
  for (let i = 0; i < 2; i++) await handleDelivery(pool, rabbit.channel, topology, await message(), consumerSettings, logger);
  assert.equal((await pool.query("SELECT applied_events FROM order_projections")).rows[0]?.applied_events, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM consumed_events")).rows[0]?.count, 1);
});

test("unroutable messages do not mark outbox records published", async () => {
  await create();
  const publisher = { publish: (event: OrderEvent) => publishConfirmed(rabbit.channel, topology.exchange, "missing-route",
    Buffer.from(JSON.stringify(event)), { messageId: event.eventId }, 3000) };
  assert.equal(await dispatchOnce(pool, publisher, settings), "retry");
  assert.equal((await pool.query("SELECT status FROM outbox_events")).rows[0]?.status, "pending");
});

test("consumer inbox rolls back with failed effects and concurrent duplicate deliveries apply once", async () => {
  await create();
  const event = (await events())[0]!;
  await pool.query("ALTER TABLE order_projections ADD CONSTRAINT simulated_projection_failure CHECK (quantity <> 2)");
  try {
    await assert.rejects(consumeEvent(pool, event));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM consumed_events")).rows[0]?.count, 0);
  } finally { await pool.query("ALTER TABLE order_projections DROP CONSTRAINT simulated_projection_failure"); }
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeEvent(pool, event)));
  assert.equal(results.filter((result) => result === "applied").length, 1);
  assert.equal((await pool.query("SELECT applied_events FROM order_projections")).rows[0]?.applied_events, 1);
});

test("consumer retries cancellation before creation and dead-letters malformed messages", async () => {
  const order = await create();
  await service.cancel("user", order.id);
  const [created, cancelled] = await events();
  const publisher = rabbitPublisher(rabbit.channel, topology, 3000);
  await publisher.publish(cancelled!);
  await handleDelivery(pool, rabbit.channel, topology, await message(), consumerSettings, logger);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM consumed_events")).rows[0]?.count, 0);
  await consumeEvent(pool, created);
  await handleDelivery(pool, rabbit.channel, topology, await message(), consumerSettings, logger);
  assert.deepEqual((await pool.query("SELECT status, applied_events FROM order_projections")).rows[0], { status: "cancelled", applied_events: 2 });
  await publishConfirmed(rabbit.channel, topology.exchange, "order", Buffer.from("{"), { messageId: randomUUID() }, 3000);
  await handleDelivery(pool, rabbit.channel, topology, await message(), consumerSettings, logger);
  const dead = await message(topology.deadQueue);
  assert.equal(dead.content.toString(), "{");
  rabbit.channel.ack(dead);
});

test("consumer sends exhausted retries to the durable dead queue", async () => {
  const order = await create();
  await service.cancel("user", order.id);
  const cancelled = (await events())[1]!;
  await rabbitPublisher(rabbit.channel, topology, 3000).publish(cancelled);
  for (let i = 0; i < 2; i++) await handleDelivery(pool, rabbit.channel, topology, await message(), consumerSettings, logger);
  const dead = await message(topology.deadQueue);
  assert.equal(dead.properties.headers?.retryCount, 2);
  rabbit.channel.ack(dead);
  assert.equal(await rabbit.channel.get(topology.queue), false);
});

test("outbox migration backfills existing created and cancelled orders without changing inventory", async () => {
  const upgradeSchema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "order-migrations-"));
  const upgrade = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${upgradeSchema}` });
  try {
    await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
    for (const file of ["001_orders.sql", "002_order_pagination.sql", "003_order_cancellation.sql"]) {
      await copyFile(new URL(`../db/migrations/${file}`, import.meta.url), join(directory, file));
    }
    await migrate(upgrade, pathToFileURL(`${directory}/`));
    await upgrade.query("INSERT INTO products (id, price_cents, stock) VALUES ($1, 1999, 10)", [productId]);
    const created = randomUUID();
    const cancelled = randomUUID();
    await upgrade.query(`INSERT INTO orders (id, user_id, product_id, quantity, total_cents) VALUES ($1, 'user', $2, 1, 1999)`, [created, productId]);
    await upgrade.query(`INSERT INTO orders (id, user_id, product_id, quantity, total_cents, status, cancelled_at)
      VALUES ($1, 'user', $2, 1, 1999, 'cancelled', now())`, [cancelled, productId]);
    await migrate(upgrade);
    const rows = (await upgrade.query<{ payload: OrderEvent }>("SELECT payload FROM outbox_events ORDER BY sequence")).rows;
    assert.equal(rows.length, 3);
    for (const row of rows) await consumeEvent(upgrade, row.payload);
    assert.equal((await upgrade.query("SELECT status FROM order_projections WHERE order_id = $1", [cancelled])).rows[0]?.status, "cancelled");
    assert.equal((await upgrade.query("SELECT status FROM order_projections WHERE order_id = $1", [created])).rows[0]?.status, "created");
    assert.equal((await upgrade.query("SELECT stock FROM products")).rows[0]?.stock, 10);
    await migrate(upgrade);
    assert.equal((await upgrade.query("SELECT count(*)::int AS count FROM outbox_events")).rows[0]?.count, 3);
  } finally {
    await upgrade.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { SignJWT, type JWTPayload } from "jose";
import { Pool } from "pg";
import { pino } from "pino";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import type { OrderResponse, OrderPage, OrderDetails } from "../src/orders/contracts.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database. Tests never use DATABASE_URL.");
// Create an isolated schema; the test suite never truncates application tables.
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
const pool = new Pool({ connectionString: databaseUrl, max: 20, connectionTimeoutMillis: 3000, options: `-c search_path=${schema}` });
const config = loadConfig({
  NODE_ENV: "test", DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-at-least-32-bytes-long-for-api",
});
const app = createApp(pool, config, pino({ level: "silent" }));
const server = app.listen(0, "127.0.0.1");
let baseUrl: string;
let token: string;
const productId = "7106f556-b21c-4a1f-b155-44327735deae";

async function signToken(userId = "user-a", overrides: { audience?: string; expiration?: number; issuer?: string; claims?: JWTPayload } = {}) {
  return new SignJWT(overrides.claims ?? { scope: "orders:read orders:create orders:cancel" }).setProtectedHeader({ alg: "HS256" })
    .setSubject(userId).setIssuer(overrides.issuer ?? config.JWT_ISSUER)
    .setAudience(overrides.audience ?? config.JWT_AUDIENCE)
    .setIssuedAt().setExpirationTime(overrides.expiration ?? Math.floor(Date.now() / 1000) + 60)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
}

before(async () => {
  if (!server.listening) await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  token = await signToken();
});
beforeEach(async () => {
  await pool.query("TRUNCATE outbox_events, idempotency_requests, orders, products");
  await pool.query("INSERT INTO products (id, price_cents, stock) VALUES ($1, 1999, 10)", [productId]);
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await admin.end(); }
});

async function post(body: unknown = { productId, quantity: 2 }, key: string = randomUUID(), auth = token) {
  return fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
}
async function state() {
  const result = await pool.query<{ stock: number; orders: number; claims: number }>(
    `SELECT stock, (SELECT count(*)::int FROM orders) AS orders,
     (SELECT count(*)::int FROM idempotency_requests) AS claims FROM products WHERE id = $1`, [productId],
  );
  return result.rows[0];
}

test("creates an order using the database price and serves its Location", async () => {
  const response = await post();
  assert.equal(response.status, 201);
  const order = await response.json() as OrderResponse;
  assert.equal(order.totalCents, 3998);
  assert.equal(order.quantity, 2);
  const location = response.headers.get("Location");
  assert.equal(location, `/api/orders/${order.id}`);
  const read = await fetch(`${baseUrl}${location}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(read.status, 200);
  const details = await read.json() as OrderDetails;
  assert.deepEqual({ id: details.id, productId: details.productId, quantity: details.quantity, totalCents: details.totalCents }, order);
  assert.equal(details.status, "created");
  assert.deepEqual(await state(), { stock: 8, orders: 1, claims: 1 });
});

test("parallel retries return one stored response and consume stock once", async () => {
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 12 }, () => post({ productId, quantity: 2 }, key)));
  assert.ok(responses.every((response) => response.status === 201));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.deepEqual(await state(), { stock: 8, orders: 1, claims: 1 });
});

test("parallel distinct orders cannot oversell inventory", async () => {
  await pool.query("UPDATE products SET stock = 5 WHERE id = $1", [productId]);
  const responses = await Promise.all(Array.from({ length: 12 }, () => post({ productId, quantity: 1 })));
  assert.equal(responses.filter((response) => response.status === 201).length, 5);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.deepEqual(await state(), { stock: 0, orders: 5, claims: 5 });
});

test("rejects a different payload for an existing key", async () => {
  const key = randomUUID();
  assert.equal((await post({ productId, quantity: 2 }, key)).status, 201);
  const response = await post({ productId, quantity: 3 }, key);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "IDEMPOTENCY_KEY_REUSED");
  assert.deepEqual(await state(), { stock: 8, orders: 1, claims: 1 });
});

test("scopes keys and order access to the authenticated user", async () => {
  const key = randomUUID();
  const first = await post({ productId, quantity: 1 }, key);
  const firstOrder = await first.json() as OrderResponse;
  const otherToken = await signToken("user-b");
  const second = await post({ productId, quantity: 1 }, key, otherToken);
  assert.equal(second.status, 201);
  const secondOrder = await second.json() as OrderResponse;
  assert.notEqual(firstOrder.id, secondOrder.id);
  const read = await fetch(`${baseUrl}/api/orders/${firstOrder.id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(read.status, 404);
  assert.deepEqual(await state(), { stock: 8, orders: 2, claims: 2 });
});

test("normalizes UUID casing for idempotent requests", async () => {
  const key = randomUUID();
  const first = await post({ productId, quantity: 1 }, key);
  const second = await post({ productId: productId.toUpperCase(), quantity: 1 }, key.toUpperCase());
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), await first.json());
  assert.deepEqual(await state(), { stock: 9, orders: 1, claims: 1 });
});

test("failed reservations roll back the key so the request can be retried", async () => {
  const key = randomUUID();
  await pool.query("UPDATE products SET stock = 0 WHERE id = $1", [productId]);
  const response = await post({ productId, quantity: 2 }, key);
  assert.equal(response.status, 409);
  assert.deepEqual(await state(), { stock: 0, orders: 0, claims: 0 });
  await pool.query("UPDATE products SET stock = 3 WHERE id = $1", [productId]);
  assert.equal((await post({ productId, quantity: 2 }, key)).status, 201);
  assert.deepEqual(await state(), { stock: 1, orders: 1, claims: 1 });
});

test("missing products return 404 without storing a key", async () => {
  const response = await post({ productId: randomUUID(), quantity: 1 });
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { code: string }).code, "PRODUCT_NOT_FOUND");
  assert.deepEqual(await state(), { stock: 10, orders: 0, claims: 0 });
});

test("an order insert failure rolls back the inventory reservation and claim", async () => {
  await pool.query("ALTER TABLE orders ADD CONSTRAINT simulated_failure CHECK (quantity <> 3)");
  try {
    const response = await post({ productId, quantity: 3 });
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { code: string }).code, "INTERNAL_ERROR");
    assert.deepEqual(await state(), { stock: 10, orders: 0, claims: 0 });
  } finally {
    await pool.query("ALTER TABLE orders DROP CONSTRAINT simulated_failure");
  }
});

test("a database lock timeout returns a retryable error and releases the connection", async () => {
  const blocker = await pool.connect();
  const key = randomUUID();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM products WHERE id = $1 FOR UPDATE", [productId]);
    const response = await post({ productId, quantity: 1 }, key);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal((await response.json() as { code: string }).code, "DATABASE_BUSY");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  assert.deepEqual(await state(), { stock: 10, orders: 0, claims: 0 });
  assert.equal((await post({ productId, quantity: 1 }, key)).status, 201);
});

test("validates body and idempotency key strictly", async () => {
  for (const body of [
    { productId, quantity: 0 }, { productId, quantity: 101 }, { productId, quantity: 1.5 },
    { productId, quantity: "2" }, { productId, quantity: 2, priceCents: 1 },
    { productId: "invalid", quantity: 2 }, { productId, quantity: 2, userId: "someone-else" },
  ]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ productId, quantity: 1 }, "invalid")).status, 400);
  const missing = await fetch(`${baseUrl}/api/orders`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ productId, quantity: 1 }),
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await state(), { stock: 10, orders: 0, claims: 0 });
});

test("rejects missing, tampered, expired and wrong-audience tokens", async () => {
  const missing = await fetch(`${baseUrl}/api/orders`, { method: "POST" });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("WWW-Authenticate"), "Bearer");
  for (const invalid of ["not-a-jwt", `${token.slice(0, -10)}xxxxxxxxxx`,
    await signToken("user-a", { expiration: Math.floor(Date.now() / 1000) - 60 }),
    await signToken("user-a", { audience: "different-api" }),
  ]) assert.equal((await post(undefined, randomUUID(), invalid)).status, 401);
  assert.deepEqual(await state(), { stock: 10, orders: 0, claims: 0 });
});

test("handles malformed and oversized JSON with a request ID", async () => {
  for (const [body, status] of [["{", 400], [JSON.stringify({ data: "x".repeat(20_000) }), 413]] as const) {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, status);
    const error = await response.json() as { requestId: string };
    assert.equal(error.requestId, response.headers.get("X-Request-Id"));
  }
});

test("health probes work and migrations are repeatable", async () => {
  assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
  await migrate(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count, 4);
});

test("me returns only verified identity, roles and scopes", async () => {
  const jwt = await signToken("profile-user", { claims: { roles: ["buyer", "buyer"], scope: "orders:read orders:read", email: "private@example.com" } });
  const response = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { userId: "profile-user", roles: ["buyer"], scopes: ["orders:read"] });
  assert.equal((await fetch(`${baseUrl}/api/me`)).status, 401);
});

test("rejects invalid subjects, malformed claims and wrong issuer", async () => {
  const tokens = [await signToken(""), await signToken(" "), await signToken("user-a", { issuer: "untrusted" }),
    await signToken("user-a", { claims: { roles: "admin" } }), await signToken("user-a", { claims: { scope: ["orders:read"] } })];
  const noSubject = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE).setIssuedAt().setExpirationTime("1m").sign(new TextEncoder().encode(config.JWT_SECRET));
  for (const jwt of [...tokens, noSubject]) {
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${jwt}` } })).status, 401);
  }
});

test("valid tokens require explicit scopes; roles cannot grant permissions", async () => {
  for (const claims of [{}, { roles: ["admin"] }, { scope: "orders:read" }]) {
    const restricted = await signToken("user-a", { claims });
    assert.equal((await post(undefined, randomUUID(), restricted)).status, 403);
  }
  const createOnly = await signToken("user-a", { claims: { scope: "orders:create" } });
  const order = await (await post(undefined, randomUUID(), createOnly)).json() as OrderResponse;
  assert.equal((await fetch(`${baseUrl}/api/orders/${order.id}`, { headers: { Authorization: `Bearer ${createOnly}` } })).status, 403);
});

test("inventory replacement requires inventory scope and validates stock", async () => {
  const replace = (auth: string, stock: unknown, id = productId) => fetch(`${baseUrl}/api/products/${id}/stock`, {
    method: "PUT", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify({ stock }),
  });
  assert.equal((await replace(token, 20)).status, 403);
  const inventoryToken = await signToken("manager", { claims: { scope: "inventory:write" } });
  assert.equal((await replace(inventoryToken, -1)).status, 400);
  assert.equal((await replace(inventoryToken, "20")).status, 400);
  assert.equal((await replace(inventoryToken, 20, randomUUID())).status, 404);
  for (let i = 0; i < 2; i++) {
    const response = await replace(inventoryToken, 20);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { productId, stock: 20 });
  }
  assert.deepEqual(await state(), { stock: 20, orders: 0, claims: 0 });
});

test("cursor pagination preserves timestamp precision and isolates users", async () => {
  const ids = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
  for (const [i, id] of ids.entries()) {
    await pool.query(`INSERT INTO orders (id, user_id, product_id, quantity, total_cents, created_at)
      VALUES ($1, 'user-a', $2, 1, 1999, $3)`, [id, productId, i < 3 ? "2026-01-01T12:00:00.123456Z" : "2026-01-01T12:00:00.123455Z"]);
  }
  await pool.query("INSERT INTO orders (id, user_id, product_id, quantity, total_cents) VALUES ($1, 'user-b', $2, 1, 1999)", [randomUUID(), productId]);
  const list = (query: string, jwt = token) => fetch(`${baseUrl}/api/orders?${query}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const first = await (await list("limit=2")).json() as OrderPage;
  assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
  assert.equal(first.items[0]?.createdAt, "2026-01-01T12:00:00.123456Z");
  assert.ok(first.nextCursor);
  // A new, newer order must not shift already established page boundaries.
  await post({ productId, quantity: 1 });
  const second = await (await list(`limit=2&cursor=${first.nextCursor}`)).json() as OrderPage;
  const third = await (await list(`limit=2&cursor=${second.nextCursor}`)).json() as OrderPage;
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.id), ids);
  assert.equal(third.nextCursor, null);
  assert.equal((await list(`cursor=${first.nextCursor}`, await signToken("user-b"))).status, 400);
  assert.equal((await list(`cursor=${first.nextCursor}&status=created`)).status, 400);
});

test("order list validates filters and returns bounded pages", async () => {
  await post();
  const list = (query: string) => fetch(`${baseUrl}/api/orders?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  for (const query of ["limit=0", "limit=101", "limit=2&limit=3", "cursor=garbage", "status=unknown", "from=yesterday", "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z", "extra=1"]) {
    assert.equal((await list(query)).status, 400);
  }
  const empty = await (await list("status=cancelled")).json() as OrderPage;
  assert.deepEqual(empty, { items: [], nextCursor: null });
  assert.equal(((await (await list("status=created&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z")).json()) as OrderPage).items.length, 1);
});

const cancelOrder = (id: string, jwt = token) => fetch(`${baseUrl}/api/orders/${id}/cancel`, {
  method: "POST", headers: { Authorization: `Bearer ${jwt}` },
});

test("concurrent cancellations restore inventory once and preserve creation replay", async () => {
  const key = randomUUID();
  const creation = await (await post({ productId, quantity: 2 }, key)).json() as OrderResponse;
  const responses = await Promise.all(Array.from({ length: 10 }, () => cancelOrder(creation.id)));
  assert.ok(responses.every((response) => response.status === 200));
  const bodies = await Promise.all(responses.map((response) => response.json())) as OrderDetails[];
  assert.equal(bodies[0]?.status, "cancelled");
  assert.ok(bodies[0]?.cancelledAt);
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.deepEqual(await state(), { stock: 10, orders: 1, claims: 1 });
  assert.deepEqual(await (await post({ productId, quantity: 2 }, key)).json(), creation);
  const details = await (await fetch(`${baseUrl}/api/orders/${creation.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(details, bodies[0]);
});

test("cancellation checks owner and scope and rolls back stock if the status update fails", async () => {
  const creation = await (await post()).json() as OrderResponse;
  assert.equal((await cancelOrder(creation.id, await signToken("user-b"))).status, 404);
  assert.equal((await cancelOrder(randomUUID())).status, 404);
  assert.equal((await cancelOrder(creation.id, await signToken("user-a", { claims: { scope: "orders:read" } }))).status, 403);
  await pool.query("ALTER TABLE orders ADD CONSTRAINT simulated_cancel_failure CHECK (status <> 'cancelled')");
  try {
    assert.equal((await cancelOrder(creation.id)).status, 500);
    assert.deepEqual(await state(), { stock: 8, orders: 1, claims: 1 });
    assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [creation.id])).rows[0]?.status, "created");
  } finally {
    await pool.query("ALTER TABLE orders DROP CONSTRAINT simulated_cancel_failure");
  }
  assert.equal((await cancelOrder(creation.id)).status, 200);
});

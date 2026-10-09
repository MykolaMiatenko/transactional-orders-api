import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, databaseErrorCode } from "../errors.js";
import type { CreateOrderInput, OrderResponse, OrderDetails, OrderPage } from "./contracts.js";
import { decodeCursor, encodeCursor, type ListOrdersInput } from "./pagination.js";

const operation = "create-order:v1";
// Preserve PostgreSQL microseconds so a cursor cannot skip rows with sub-millisecond timestamps.
const orderColumns = `id, product_id AS "productId", quantity, total_cents AS "totalCents", status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

export class OrderService {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, requestKey: string, input: CreateOrderInput): Promise<OrderResponse> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify([input.productId, input.quantity]))
      .digest("hex");
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      // READ COMMITTED gives the replay query a fresh snapshot after a competing insert commits.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const claim = await client.query(
        `INSERT INTO idempotency_requests (user_id, operation, request_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING request_key`,
        [userId, operation, requestKey, requestHash],
      );

      if (claim.rowCount === 0) {
        const existing = await client.query<{ request_hash: string; response: OrderResponse | null }>(
          `SELECT request_hash, response FROM idempotency_requests
           WHERE user_id = $1 AND operation = $2 AND request_key = $3`,
          [userId, operation, requestKey],
        );
        const previous = existing.rows[0];
        if (!previous || previous.response === null) throw new Error("Invalid idempotency state");
        if (previous.request_hash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This key was already used for a different request.");
        }
        await client.query("COMMIT");
        return previous.response;
      }

      // A conditional update reserves stock atomically, including across API instances.
      const reservation = await client.query<{ price_cents: number }>(
        `UPDATE products SET stock = stock - $2
         WHERE id = $1 AND stock >= $2 RETURNING price_cents`,
        [input.productId, input.quantity],
      );
      const product = reservation.rows[0];
      if (!product) {
        const exists = await client.query("SELECT 1 FROM products WHERE id = $1", [input.productId]);
        if (exists.rowCount === 0) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product was not found.");
        throw new ApiError(409, "INSUFFICIENT_STOCK", "Not enough items in stock.");
      }

      const response: OrderResponse = {
        id: randomUUID(),
        productId: input.productId,
        quantity: input.quantity,
        totalCents: product.price_cents * input.quantity,
      };
      await client.query(
        `INSERT INTO orders (id, user_id, product_id, quantity, total_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [response.id, userId, response.productId, response.quantity, response.totalCents],
      );
      await client.query(
        `UPDATE idempotency_requests SET response = $4::jsonb
         WHERE user_id = $1 AND operation = $2 AND request_key = $3`,
        [userId, operation, requestKey, JSON.stringify(response)],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A connection that cannot roll back must never be returned to the pool.
        discardConnection = true;
      }
      if (["55P03", "57014", "40P01", "40001"].includes(databaseErrorCode(error) ?? "")) {
        throw new ApiError(503, "DATABASE_BUSY", "Please retry with the same Idempotency-Key.");
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }

  async get(userId: string, id: string): Promise<OrderDetails> {
    const result = await this.pool.query<OrderDetails>(
      `SELECT ${orderColumns}
       FROM orders WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const order = result.rows[0];
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found.");
    return order;
  }

  async list(userId: string, input: ListOrdersInput): Promise<OrderPage> {
    const cursor = decodeCursor(userId, input);
    const values: unknown[] = [userId];
    const conditions = ["user_id = $1"];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (input.status) conditions.push(`status = ${parameter(input.status)}`);
    if (input.from) conditions.push(`created_at >= ${parameter(input.from)}::timestamptz`);
    if (input.to) conditions.push(`created_at <= ${parameter(input.to)}::timestamptz`);
    if (cursor) conditions.push(`(created_at, id) < (${parameter(cursor.createdAt)}::timestamptz, ${parameter(cursor.id)}::uuid)`);
    const result = await this.pool.query<OrderDetails>(
      `SELECT ${orderColumns} FROM orders WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ${parameter(input.limit + 1)}`, values,
    );
    const items = result.rows.slice(0, input.limit);
    const last = items.at(-1);
    return { items, nextCursor: result.rows.length > input.limit && last ? encodeCursor(userId, input, last) : null };
  }
}

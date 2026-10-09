import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrderResponse } from "../orders/contracts.js";
import { transaction } from "../transaction.js";
import type { OrderEvent } from "./contracts.js";

export async function appendEvent(client: PoolClient, type: OrderEvent["type"], order: OrderResponse): Promise<void> {
  const event: OrderEvent = { eventId: randomUUID(), version: 1, type, occurredAt: new Date().toISOString(),
    data: { orderId: order.id, productId: order.productId, quantity: order.quantity, totalCents: order.totalCents } };
  await client.query(
    "INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)",
    [event.eventId, order.id, type, JSON.stringify(event)],
  );
}

export type Delivery = { eventId: string; lockToken: string; attempts: number; payload: OrderEvent };
export type DispatchSettings = { leaseMs: number; maxAttempts: number; backoffMs: number };
export interface EventPublisher { publish(event: OrderEvent): Promise<void> }

export async function claimEvent(pool: Pool, settings: DispatchSettings): Promise<Delivery | undefined> {
  return transaction(pool, async (client) => {
    // Expired final attempts become visible failures instead of staying leased forever.
    await client.query(
      `UPDATE outbox_events SET status = 'failed', locked_until = NULL, lock_token = NULL,
       last_error = 'Lease expired on final attempt'
       WHERE status = 'processing' AND locked_until <= now() AND attempts >= $1`, [settings.maxAttempts],
    );
    const result = await client.query<{ event_id: string; attempts: number; payload: OrderEvent }>(
      `SELECT e.event_id, e.attempts, e.payload FROM outbox_events e
       WHERE ((e.status = 'pending' AND e.available_at <= now()) OR
              (e.status = 'processing' AND e.locked_until <= now())) AND e.attempts < $1
         AND NOT EXISTS (SELECT 1 FROM outbox_events earlier WHERE earlier.aggregate_id = e.aggregate_id
           AND earlier.sequence < e.sequence AND earlier.status <> 'published')
       ORDER BY e.sequence FOR UPDATE OF e SKIP LOCKED LIMIT 1`, [settings.maxAttempts],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const lockToken = randomUUID();
    await client.query(
      `UPDATE outbox_events SET status = 'processing', attempts = attempts + 1,
       lock_token = $2, locked_until = now() + ($3 * interval '1 millisecond') WHERE event_id = $1`,
      [row.event_id, lockToken, settings.leaseMs],
    );
    return { eventId: row.event_id, lockToken, attempts: row.attempts + 1, payload: row.payload };
  });
}

export async function completeEvent(pool: Pool, delivery: Delivery): Promise<boolean> {
  const result = await pool.query(
    `UPDATE outbox_events SET status = 'published', published_at = now(), last_error = NULL,
     locked_until = NULL, lock_token = NULL WHERE event_id = $1 AND lock_token = $2 AND status = 'processing'`,
    [delivery.eventId, delivery.lockToken],
  );
  return result.rowCount === 1;
}

export async function retryEvent(pool: Pool, delivery: Delivery, settings: DispatchSettings): Promise<void> {
  const delay = Math.min(settings.backoffMs * 2 ** (delivery.attempts - 1), 300_000);
  await pool.query(
    `UPDATE outbox_events SET status = $3, last_error = 'Broker delivery or database acknowledgement failed',
     available_at = now() + ($4 * interval '1 millisecond'), locked_until = NULL, lock_token = NULL
     WHERE event_id = $1 AND lock_token = $2 AND status = 'processing'`,
    [delivery.eventId, delivery.lockToken, delivery.attempts >= settings.maxAttempts ? "failed" : "pending", delay],
  );
}

export async function dispatchOnce(pool: Pool, publisher: EventPublisher, settings: DispatchSettings): Promise<"idle" | "published" | "retry"> {
  const delivery = await claimEvent(pool, settings);
  if (!delivery) return "idle";
  try {
    await publisher.publish(delivery.payload);
    // A lease token fences late workers; an expired delivery may already have been reclaimed.
    if (!await completeEvent(pool, delivery)) throw new Error("Delivery lease was superseded");
    return "published";
  } catch {
    await retryEvent(pool, delivery, settings);
    return "retry";
  }
}

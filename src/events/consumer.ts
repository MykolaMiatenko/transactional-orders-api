import type { Pool } from "pg";
import { transaction } from "../transaction.js";
import { eventSchema } from "./contracts.js";

export async function consumeEvent(pool: Pool, input: unknown): Promise<"applied" | "duplicate"> {
  const event = eventSchema.parse(input);
  return transaction(pool, async (client) => {
    // The inbox marker and projection change commit together, before the broker acknowledgement.
    const claim = await client.query(
      "INSERT INTO consumed_events (consumer_name, event_id) VALUES ('order-projection:v1', $1) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId],
    );
    if (!claim.rowCount) return "duplicate";
    if (event.type === "OrderCreated") {
      await client.query(
        `INSERT INTO order_projections (order_id, product_id, quantity, total_cents, status)
         VALUES ($1, $2, $3, $4, 'created')`,
        [event.data.orderId, event.data.productId, event.data.quantity, event.data.totalCents],
      );
    } else {
      const updated = await client.query(
        "UPDATE order_projections SET status = 'cancelled', applied_events = applied_events + 1 WHERE order_id = $1 AND status = 'created'",
        [event.data.orderId],
      );
      // Multiple consumers may observe cancellation before creation; defer rather than lose the event.
      if (updated.rowCount !== 1) throw new Error("Creation projection is not ready");
    }
    return "applied";
  });
}

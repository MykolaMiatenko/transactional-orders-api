import { z } from "zod";

export const eventSchema = z.object({
  eventId: z.uuid(),
  version: z.literal(1),
  type: z.enum(["OrderCreated", "OrderCancelled"]),
  occurredAt: z.iso.datetime(),
  data: z.object({
    orderId: z.uuid(), productId: z.uuid(), quantity: z.number().int().min(1).max(100),
    totalCents: z.number().int().min(0).max(100_000_000),
  }).strict(),
}).strict();
export type OrderEvent = z.infer<typeof eventSchema>;

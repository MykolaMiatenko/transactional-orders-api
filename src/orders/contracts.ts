import { z } from "zod";

export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
export const createOrderSchema = z.object({
  productId: uuidSchema,
  quantity: z.number().int().min(1).max(100),
}).strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type OrderResponse = {
  id: string;
  productId: string;
  quantity: number;
  totalCents: number;
};

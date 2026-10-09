import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireScopes } from "./authorization.js";
import { ApiError } from "./errors.js";
import { uuidSchema } from "./orders/contracts.js";

export function createInventoryRouter(pool: Pool, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate, requireScopes("inventory:write"));
  // Absolute stock replacement is naturally idempotent and serializes with order reservations.
  router.put("/:id/stock", async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = z.object({ stock: z.number().int().min(0).max(2_000_000_000) }).strict().safeParse(req.body);
    if (!id.success || !body.success) throw new ApiError(400, "INVALID_REQUEST", "Provide a valid product ID and nonnegative integer stock.");
    const result = await pool.query<{ productId: string; stock: number }>(
      'UPDATE products SET stock = $2 WHERE id = $1 RETURNING id AS "productId", stock', [id.data, body.data.stock],
    );
    if (!result.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product was not found.");
    res.json(result.rows[0]);
  });
  return router;
}

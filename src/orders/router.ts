import { Router, type RequestHandler } from "express";
import { ApiError } from "../errors.js";
import { createOrderSchema, uuidSchema } from "./contracts.js";
import type { OrderService } from "./service.js";
import { getUser } from "../user.js";

export function createOrdersRouter(service: OrderService, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate);
  router.post("/", async (req, res) => {
    const body = createOrderSchema.safeParse(req.body);
    const key = uuidSchema.safeParse(req.get("Idempotency-Key"));
    if (!body.success || !key.success) {
      throw new ApiError(400, "INVALID_REQUEST", "Check the request body and Idempotency-Key header.");
    }
    const order = await service.create(getUser(res).userId, key.data, body.data);
    res.status(201).location(`/api/orders/${order.id}`).json(order);
  });
  router.get("/:id", async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "INVALID_REQUEST", "Order ID must be a UUID.");
    res.json(await service.get(getUser(res).userId, id.data));
  });
  return router;
}

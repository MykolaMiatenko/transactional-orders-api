import { Router, type RequestHandler } from "express";
import { ApiError } from "../errors.js";
import { createOrderSchema, uuidSchema } from "./contracts.js";
import type { OrderService } from "./service.js";
import { getUser } from "../user.js";
import { requireScopes } from "../authorization.js";
import { listOrdersSchema } from "./pagination.js";

export function createOrdersRouter(service: OrderService, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate);
  router.get("/", requireScopes("orders:read"), async (req, res) => {
    const query = listOrdersSchema.safeParse(req.query);
    if (!query.success) throw new ApiError(400, "INVALID_REQUEST", "Check limit, status, date filters and cursor.");
    res.json(await service.list(getUser(res).userId, query.data));
  });
  router.post("/", requireScopes("orders:create"), async (req, res) => {
    const body = createOrderSchema.safeParse(req.body);
    const key = uuidSchema.safeParse(req.get("Idempotency-Key"));
    if (!body.success || !key.success) {
      throw new ApiError(400, "INVALID_REQUEST", "Check the request body and Idempotency-Key header.");
    }
    const order = await service.create(getUser(res).userId, key.data, body.data);
    res.status(201).location(`/api/orders/${order.id}`).json(order);
  });
  router.get("/:id", requireScopes("orders:read"), async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "INVALID_REQUEST", "Order ID must be a UUID.");
    res.json(await service.get(getUser(res).userId, id.data));
  });
  router.post("/:id/cancel", requireScopes("orders:cancel"), async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "INVALID_REQUEST", "Order ID must be a UUID.");
    if (req.body !== undefined && (typeof req.body !== "object" || req.body === null || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      throw new ApiError(400, "INVALID_REQUEST", "Cancellation does not accept a request body.");
    }
    res.json(await service.cancel(getUser(res).userId, id.data));
  });
  return router;
}

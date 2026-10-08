import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { createAuthenticate } from "./auth.js";
import type { Config } from "./config.js";
import { ApiError, databaseErrorCode } from "./errors.js";
import { createOrdersRouter } from "./orders/router.js";
import { OrderService } from "./orders/service.js";

export function createApp(pool: Pool, config: Config, logger: Logger) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const started = performance.now();
    res.on("finish", () => {
      // Never log authorization headers, request bodies, or query strings.
      logger.info({ requestId, method: req.method, path: req.path, status: res.statusCode,
        durationMs: Math.round(performance.now() - started) }, "Request completed");
    });
    next();
  });
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/health/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      throw new ApiError(503, "NOT_READY", "Database is unavailable.");
    }
  });
  app.use("/api/orders", createOrdersRouter(new OrderService(pool), createAuthenticate(config)));
  app.use((_req, _res) => { throw new ApiError(404, "NOT_FOUND", "Route was not found."); });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    let apiError = error instanceof ApiError ? error : undefined;
    if (!apiError && typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.parse.failed") apiError = new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
      if (error.type === "entity.too.large") apiError = new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 16 KB.");
      if (error.type === "encoding.unsupported" || error.type === "charset.unsupported") {
        apiError = new ApiError(415, "UNSUPPORTED_ENCODING", "Request encoding is unsupported.");
      }
    }
    if (!apiError && ["ECONNREFUSED", "ETIMEDOUT", "57P01", "57P02", "57P03", "53300", "08006"].includes(databaseErrorCode(error) ?? "")) {
      apiError = new ApiError(503, "DATABASE_UNAVAILABLE", "Please retry with the same Idempotency-Key.");
    }
    const status = apiError?.status ?? 500;
    // Log safe classifications instead of raw errors that can contain SQL data or JSON bodies.
    const details = { requestId: res.locals.requestId, code: apiError?.code ?? "INTERNAL_ERROR", databaseCode: databaseErrorCode(error) };
    if (status >= 500) logger.error(details, "Request failed");
    else logger.warn(details, "Request rejected");
    if (status === 401) res.setHeader("WWW-Authenticate", "Bearer");
    if (status === 503) res.setHeader("Retry-After", "1");
    res.status(status).json({
      code: apiError?.code ?? "INTERNAL_ERROR",
      message: apiError?.message ?? "An unexpected error occurred.",
      requestId: res.locals.requestId,
    });
  };
  app.use(errorHandler);
  return app;
}

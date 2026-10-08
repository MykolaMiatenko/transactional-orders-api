import { Pool } from "pg";
import type { Logger } from "pino";
import type { Config } from "./config.js";

export function createPool(config: Config, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5000,
    application_name: "order-api",
  });
  pool.on("error", (error) => logger.error({ err: error }, "Idle database connection failed"));
  return pool;
}

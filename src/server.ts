import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const pool = createPool(config, logger);

try {
  await pool.query("SELECT 1 FROM products LIMIT 0");
} catch {
  logger.fatal("Database initialization failed. Check connectivity and run migrations.");
  await pool.end();
  process.exit(1);
}

const server = createApp(pool, config, logger).listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "Order API started");
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
let stopping = false;

function shutdown(signal: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down");
  // Stop accepting requests, drain active handlers, then close the database pool.
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
  deadline.unref();
  server.close(() => {
    void pool.end().then(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    }).catch(() => process.exit(1));
  });
}

server.on("error", () => { logger.fatal("HTTP server failed"); shutdown("server-error", 1); });
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import "dotenv/config";
import { Pool } from "pg";

if (process.env.NODE_ENV === "production") throw new Error("Demo seed is disabled in production.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  // Re-running the seed must not replenish inventory consumed by existing orders.
  await pool.query(
    `INSERT INTO products (id, price_cents, stock) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    ["7106f556-b21c-4a1f-b155-44327735deae", 1999, 100],
  );
  console.log("Demo product: 7106f556-b21c-4a1f-b155-44327735deae (1999 cents, initial stock 100).");
} finally {
  await pool.end();
}

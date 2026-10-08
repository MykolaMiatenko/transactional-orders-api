import "dotenv/config";
import { Pool } from "pg";
import { migrate } from "../src/migrate.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  await migrate(pool);
  console.log("Migrations applied successfully.");
} finally {
  await pool.end();
}

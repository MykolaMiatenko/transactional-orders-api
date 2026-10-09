import type { Pool, PoolClient } from "pg";
import { ApiError, databaseErrorCode } from "./errors.js";

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    if (["55P03", "57014", "40P01", "40001"].includes(databaseErrorCode(error) ?? "")) {
      throw new ApiError(503, "DATABASE_BUSY", "Please retry the operation.");
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

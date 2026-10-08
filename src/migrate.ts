import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

const sourceDirectory = new URL("../db/migrations/", import.meta.url);
const defaultDirectory = existsSync(sourceDirectory) ? sourceDirectory : new URL("../../db/migrations/", import.meta.url);

export async function migrate(pool: Pool, directory = defaultDirectory): Promise<void> {
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    // Serialize migrations across processes using a transaction-scoped advisory lock.
    await client.query("SELECT pg_advisory_xact_lock(73429101)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1", [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration has changed: ${file}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

for (const name of migrationNames) {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const existing = await pool.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
  if (existing.rowCount) {
    if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed`);
    continue;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
    await client.query("COMMIT");
    console.log(`Applied migration ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

console.log("CRM database migrations complete");
await pool.end();

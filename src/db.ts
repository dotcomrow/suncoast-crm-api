import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config().DATABASE_URL,
  ssl: config().DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  statement_timeout: 15_000,
  application_name: "suncoast-crm-api"
});

pool.on("error", (error) => {
  console.error("Unexpected idle PostgreSQL client error; the pool will replace the connection", error);
});

export async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

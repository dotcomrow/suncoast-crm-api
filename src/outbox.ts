import { inTransaction } from "./db.js";
import { publish } from "./kafka.js";
import { claimOutbox } from "./repository.js";
import { config } from "./config.js";

let stopped = false;
export function stopOutbox(): void { stopped = true; }
export async function dispatchOnce(): Promise<number> {
  let dispatched = 0;
  for (let index = 0; index < 100; index += 1) {
    const outcome = await inTransaction(async (client) => {
      const rows = await claimOutbox(client, 1);
      const row = rows[0];
      if (!row) return { found: false, error: undefined as unknown };
      try {
        await publish(row.topic, row.message_key, row.payload);
        await client.query("UPDATE crm_outbox SET published_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1", [row.id]);
        return { found: true, error: undefined as unknown };
      } catch (error) {
        await client.query("UPDATE crm_outbox SET attempts=attempts+1, last_error=$2, available_at=now() + make_interval(secs => LEAST(300, 5 * power(2, LEAST(attempts, 6)))::int) WHERE id=$1", [row.id, String(error)]);
        return { found: true, error };
      }
    });
    if (!outcome.found) break;
    if (outcome.error) throw outcome.error;
    dispatched += 1;
  }
  return dispatched;
}
export async function runOutbox(): Promise<void> {
  while (!stopped) {
    try { await dispatchOnce(); } catch (error) { console.error("outbox dispatch failed", error); }
    await new Promise((resolve) => setTimeout(resolve, config().OUTBOX_POLL_MS));
  }
}

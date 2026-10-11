import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import { kafka, producer } from "./kafka.js";
import { summarize } from "./ollama.js";
import { providerFor } from "./providers/registry.js";
import { ProviderError } from "./providers/provider.js";
import type { CrmCommand, CrmEntity } from "./types.js";
import { commandSchema } from "./validation.js";

let kafkaReady = false;
let shuttingDown = false;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function claimOperation(operationId: string): Promise<number | null> {
  for (;;) {
    const claimed = await pool.query(
      `UPDATE crm_operations
         SET status='processing', started_at=now(), finished_at=NULL, attempts=attempts+1
       WHERE id=$1
         AND (status IN ('queued','retrying')
              OR (status='processing' AND started_at < now() - make_interval(secs => $2)))
       RETURNING attempts`,
      [operationId, config().PROCESSING_LEASE_SECONDS]
    );
    if (claimed.rowCount) return Number(claimed.rows[0].attempts);

    const current = await pool.query("SELECT status, started_at FROM crm_operations WHERE id=$1", [operationId]);
    if (!current.rowCount || ["succeeded", "failed"].includes(current.rows[0].status)) return null;
    if (current.rows[0].status !== "processing") continue;

    const leaseEndsAt = new Date(current.rows[0].started_at).getTime() + config().PROCESSING_LEASE_SECONDS * 1000;
    await delay(Math.max(250, Math.min(5000, leaseEndsAt - Date.now())));
  }
}

export async function processCommand(command: CrmCommand): Promise<void> {
  const attempts = await claimOperation(command.operationId);
  if (attempts === null) return;

  try {
    let result: Record<string, unknown> = {};
    if (command.action === "ai.summarize") {
      const entityResult = await pool.query("SELECT properties, associations FROM crm_entities WHERE tenant_id=$1 AND entity_type=$2 AND id=$3 AND deleted_at IS NULL", [command.tenantId, command.entityType, command.entityId]);
      if (!entityResult.rowCount) throw new ProviderError("Entity not found", false, 404);
      result = await summarize(entityResult.rows[0]);
    } else {
      const provider = providerFor(command.provider);
      const existing = await pool.query("SELECT * FROM crm_entities WHERE tenant_id=$1 AND entity_type=$2 AND id=$3", [command.tenantId, command.entityType, command.entityId]);
      const row = existing.rows[0];
      const entity: CrmEntity = {
        id: command.entityId!, type: command.entityType!, provider: command.provider, providerId: row?.provider_id ?? null,
        properties: { ...(row?.properties ?? {}), ...((command.payload.properties as object | undefined) ?? {}) },
        associations: { ...(row?.associations ?? {}), ...((command.payload.associations as object | undefined) ?? {}) }, version: Number(row?.version ?? 0) + 1,
        createdAt: row?.created_at ?? new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      if (command.action === "create") {
        const written = await provider.create(command.entityType!, entity); result = { ...written };
        await pool.query(`INSERT INTO crm_entities (id,tenant_id,entity_type,provider,provider_id,properties,associations,version) VALUES ($1,$2,$3,$4,$5,$6,$7,1)
          ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id,properties=EXCLUDED.properties,associations=EXCLUDED.associations,version=crm_entities.version+1,updated_at=now(),deleted_at=NULL`,
          [entity.id, command.tenantId, entity.type, provider.name, written.providerId, entity.properties, entity.associations]);
      } else {
        if (!row) throw new ProviderError("Entity not found", false, 404);
        if (!row.provider_id) throw new ProviderError("Entity has no provider identifier", false);
        if (command.action === "update") {
          const written = await provider.update(command.entityType!, row.provider_id, entity); result = { ...written };
          await pool.query("UPDATE crm_entities SET properties=$2,associations=$3,version=version+1,updated_at=now() WHERE id=$1", [entity.id, entity.properties, entity.associations]);
        } else {
          await provider.delete(command.entityType!, row.provider_id);
          await pool.query("UPDATE crm_entities SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1", [entity.id]);
          result = { deleted: true };
        }
      }
    }
    await inTransaction(async (client) => {
      await client.query("UPDATE crm_operations SET status='succeeded', result=$2, finished_at=now(), error=NULL WHERE id=$1", [command.operationId, result]);
      await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), command.operationId, config().KAFKA_EVENT_TOPIC, command.tenantId, { schemaVersion: 1, type: "crm.operation.succeeded", operationId: command.operationId, entityId: command.entityId, tenantId: command.tenantId, result, occurredAt: new Date().toISOString() }]);
    });
  } catch (error) {
    const retryable = error instanceof ProviderError ? error.retryable : true;
    const shouldRetry = retryable && attempts < config().PROVIDER_MAX_ATTEMPTS;
    if (shouldRetry) {
      await pool.query("UPDATE crm_operations SET status='retrying',error=$2,started_at=NULL,finished_at=NULL WHERE id=$1", [command.operationId, String(error)]);
      throw error;
    }
    await inTransaction(async (client) => {
      await client.query("UPDATE crm_operations SET status='failed',error=$2,finished_at=now() WHERE id=$1", [command.operationId, String(error)]);
      await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)", [
        randomUUID(), command.operationId, config().KAFKA_DLQ_TOPIC, command.tenantId,
        { ...command, failure: String(error), failedAt: new Date().toISOString() }
      ]);
    });
  }
}

async function recoverExpiredClaims(): Promise<void> {
  await pool.query(
    `UPDATE crm_operations SET status='retrying', started_at=NULL, error='Recovered expired processing lease'
     WHERE status='processing' AND started_at < now() - make_interval(secs => $1)`,
    [config().PROCESSING_LEASE_SECONDS]
  );
}

const healthServer = createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(shuttingDown ? 503 : 200).end(shuttingDown ? "shutting down" : "ok");
    return;
  }
  if (request.url === "/readyz") {
    try {
      const schema = await pool.query("SELECT to_regclass('crm.crm_operations') AS operations");
      const ready = kafkaReady && Boolean(schema.rows[0]?.operations) && !shuttingDown;
      response.writeHead(ready ? 200 : 503).end(ready ? "ready" : "not ready");
    } catch {
      response.writeHead(503).end("not ready");
    }
    return;
  }
  response.writeHead(404).end("not found");
});
healthServer.listen(config().WORKER_HEALTH_PORT, "0.0.0.0");

const consumer = kafka().consumer({ groupId: config().KAFKA_CONSUMER_GROUP, retry: { retries: config().PROVIDER_MAX_ATTEMPTS } });

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  kafkaReady = false;
  healthServer.close();
  await consumer.disconnect().catch(() => undefined);
  await (await producer()).disconnect().catch(() => undefined);
  await pool.end();
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());

await recoverExpiredClaims();
await consumer.connect();
await consumer.subscribe({ topic: config().KAFKA_COMMAND_TOPIC, fromBeginning: false });
kafkaReady = true;
await consumer.run({
  eachMessage: async ({ message }) => {
    if (!message.value) return;
    const raw = message.value.toString();
    const parsedJson = (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })();
    const parsed = commandSchema.safeParse(parsedJson);
    if (!parsed.success) {
      await (await producer()).send({ topic: config().KAFKA_DLQ_TOPIC, messages: [{ key: "malformed", value: JSON.stringify({ type: "crm.command.rejected", failure: parsed.error.message, payload: raw, failedAt: new Date().toISOString() }) }] });
      return;
    }
    await processCommand(parsed.data);
  }
});

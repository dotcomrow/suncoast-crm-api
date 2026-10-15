import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import { kafka, producer } from "./kafka.js";
import { enqueueFailureNotification, runNotificationOutbox } from "./notifications.js";
import { summarize } from "./ollama.js";
import { providerFor } from "./providers/registry.js";
import { ProviderError } from "./providers/provider.js";
import { commandTopics, retryScheduleForAttempt } from "./retry.js";
import { getCustomObjectDefinition, getCustomRecord, persistCustomRecord } from "./custom-objects.js";
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
    } else if (command.action === "form.submit") {
      const provider = providerFor(command.provider);
      if (!provider.submitForm) throw new ProviderError(`Provider ${provider.name} does not support forms`, false, 501);
      const fields = command.payload.fields as Record<string, string>;
      const contextInput = command.payload.context as { page_uri?: string; page_name?: string; hutk?: string } | undefined;
      const consentInput = command.payload.consent as { consent_to_process: true; text: string; communications: Array<{ value: true; subscription_type_id: number; text: string }> } | undefined;
      const response = await provider.submitForm(String(command.payload.portal_id), String(command.payload.form_id), {
        fields,
        context: contextInput ? { pageUri: contextInput.page_uri, pageName: contextInput.page_name, hutk: contextInput.hutk } : undefined,
        consent: consentInput ? { consentToProcess: true, text: consentInput.text, communications: consentInput.communications.map((item) => ({ value: true, subscriptionTypeId: item.subscription_type_id, text: item.text })) } : undefined
      });
      await pool.query("UPDATE crm_form_submissions SET status='submitted',provider_response=$2,error=NULL,submitted_at=now(),updated_at=now() WHERE id=$1", [command.entityId, response]);
      result = { submissionId: command.entityId, formName: command.entityType, providerResponse: response };
    } else if (command.action.startsWith("custom.")) {
      const definition = await getCustomObjectDefinition(command.tenantId, command.entityType!);
      if (!definition) throw new ProviderError("Custom object definition not found", false, 404);
      const provider = providerFor(command.provider);
      const existing = await getCustomRecord(command.tenantId, definition.name, command.entityId!);
      if (command.action === "custom.create") {
        const contactId = String(command.payload.contact_id);
        const contact = await pool.query("SELECT provider_id FROM crm_entities WHERE tenant_id=$1 AND id=$2 AND entity_type='contacts' AND deleted_at IS NULL", [command.tenantId, contactId]);
        if (!contact.rowCount) throw new ProviderError("Contact not found", false, 404);
        const properties = command.payload.properties as Record<string, unknown>;
        let written: import("./types.js").ProviderWriteResult;
        if (definition.storage_mode === "local") {
          written = { providerId: command.entityId!, properties, raw: { storage_mode: "local" } };
        } else {
          if (!contact.rows[0].provider_id) throw new ProviderError("Contact has no provider identifier", false);
          if (definition.storage_mode === "contact_properties") {
            if (!provider.writeContactPropertyProjection) throw new ProviderError(`Provider ${provider.name} does not support contact-property projections`, false, 501);
            written = await provider.writeContactPropertyProjection(definition, String(contact.rows[0].provider_id), properties);
          } else {
            if (!provider.createCustomRecord) throw new ProviderError(`Provider ${provider.name} does not support custom records`, false, 501);
            written = await provider.createCustomRecord(definition, command.entityId!, contactId, String(contact.rows[0].provider_id), properties);
          }
        }
        await persistCustomRecord({ tenantId: command.tenantId, definitionId: definition.id, id: command.entityId!, contactId, singleton: definition.cardinality === "one_per_contact", providerId: written.providerId, properties });
        result = { ...written };
      } else {
        if (!existing) throw new ProviderError("Custom object record not found", false, 404);
        if (!existing.provider_id) throw new ProviderError("Custom object record has no provider identifier", false);
        if (command.action === "custom.update") {
          const properties = { ...(existing.properties as Record<string, unknown>), ...(command.payload.properties as Record<string, unknown>) };
          let written: import("./types.js").ProviderWriteResult;
          if (definition.storage_mode === "local") {
            written = { providerId: String(existing.provider_id), properties, raw: { storage_mode: "local" } };
          } else if (definition.storage_mode === "contact_properties") {
            if (!provider.writeContactPropertyProjection) throw new ProviderError(`Provider ${provider.name} does not support contact-property projections`, false, 501);
            written = await provider.writeContactPropertyProjection(definition, String(existing.provider_id), properties);
          } else {
            if (!provider.updateCustomRecord) throw new ProviderError(`Provider ${provider.name} does not support custom records`, false, 501);
            written = await provider.updateCustomRecord(definition, String(existing.provider_id), properties);
          }
          await pool.query("UPDATE crm_custom_object_records SET properties=$2,version=version+1,updated_at=now() WHERE id=$1", [command.entityId, properties]);
          result = { ...written };
        } else {
          if (definition.storage_mode === "contact_properties") {
            if (!provider.clearContactPropertyProjection) throw new ProviderError(`Provider ${provider.name} does not support contact-property projections`, false, 501);
            await provider.clearContactPropertyProjection(definition, String(existing.provider_id));
          } else if (definition.storage_mode === "provider_custom_object") {
            if (!provider.deleteCustomRecord) throw new ProviderError(`Provider ${provider.name} does not support custom records`, false, 501);
            await provider.deleteCustomRecord(definition, String(existing.provider_id));
          }
          await pool.query("UPDATE crm_custom_object_records SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1", [command.entityId]);
          result = { deleted: true };
        }
      }
    } else {
      const provider = providerFor(command.provider);
      const standardType = command.entityType as import("./types.js").EntityType;
      const existing = await pool.query("SELECT * FROM crm_entities WHERE tenant_id=$1 AND entity_type=$2 AND id=$3", [command.tenantId, standardType, command.entityId]);
      const row = existing.rows[0];
      const entity: CrmEntity = {
        id: command.entityId!, type: standardType, provider: command.provider, providerId: row?.provider_id ?? null,
        properties: { ...(row?.properties ?? {}), ...((command.payload.properties as object | undefined) ?? {}) },
        associations: { ...(row?.associations ?? {}), ...((command.payload.associations as object | undefined) ?? {}) }, version: Number(row?.version ?? 0) + 1,
        createdAt: row?.created_at ?? new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      if (command.action === "create") {
        const written = await provider.create(standardType, entity); result = { ...written };
        await pool.query(`INSERT INTO crm_entities (id,tenant_id,entity_type,provider,provider_id,properties,associations,version) VALUES ($1,$2,$3,$4,$5,$6,$7,1)
          ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id,properties=EXCLUDED.properties,associations=EXCLUDED.associations,version=crm_entities.version+1,updated_at=now(),deleted_at=NULL`,
          [entity.id, command.tenantId, entity.type, provider.name, written.providerId, entity.properties, entity.associations]);
      } else {
        if (!row) throw new ProviderError("Entity not found", false, 404);
        if (!row.provider_id) throw new ProviderError("Entity has no provider identifier", false);
        if (command.action === "update") {
          const written = await provider.update(standardType, row.provider_id, entity); result = { ...written };
          await pool.query("UPDATE crm_entities SET properties=$2,associations=$3,version=version+1,updated_at=now() WHERE id=$1", [entity.id, entity.properties, entity.associations]);
        } else {
          await provider.delete(standardType, row.provider_id);
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
    const retryable = error instanceof ProviderError ? error.retryable : (error as { code?: string })?.code !== "23505";
    const shouldRetry = retryable && attempts < config().PROVIDER_MAX_ATTEMPTS;
    if (shouldRetry) {
      const retry = retryScheduleForAttempt(attempts);
      await inTransaction(async (client) => {
        await client.query("UPDATE crm_operations SET status='retrying',error=$2,started_at=NULL,finished_at=NULL WHERE id=$1", [command.operationId, String(error)]);
        if (command.action === "form.submit") await client.query("UPDATE crm_form_submissions SET status='retrying',error=$2,updated_at=now() WHERE id=$1", [command.entityId, String(error)]);
        await client.query(
          `INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload,available_at)
           VALUES ($1,$2,$3,$4,$5,now() + make_interval(secs => $6))`,
          [randomUUID(), command.operationId, retry.topic, command.tenantId, command, retry.delaySeconds]
        );
        if (attempts === 1 && command.provider === "hubspot" && command.action !== "ai.summarize") {
          await enqueueFailureNotification(client, command, error, attempts, "retrying");
        }
      });
      return;
    }
    await inTransaction(async (client) => {
      await client.query("UPDATE crm_operations SET status='failed',error=$2,finished_at=now() WHERE id=$1", [command.operationId, String(error)]);
      if (command.action === "form.submit") await client.query("UPDATE crm_form_submissions SET status='failed',error=$2,updated_at=now() WHERE id=$1", [command.entityId, String(error)]);
      await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)", [
        randomUUID(), command.operationId, config().KAFKA_DLQ_TOPIC, command.tenantId,
        { ...command, failure: String(error), failedAt: new Date().toISOString() }
      ]);
      if (command.provider === "hubspot" && command.action !== "ai.summarize") {
        await enqueueFailureNotification(client, command, error, attempts, "failed");
      }
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
      const schema = await pool.query("SELECT to_regclass('crm.crm_operations') AS operations, to_regclass('crm.crm_custom_object_records') AS custom_records, to_regclass('crm.crm_form_submissions') AS form_submissions");
      const ready = kafkaReady && Boolean(schema.rows[0]?.operations) && Boolean(schema.rows[0]?.custom_records) && Boolean(schema.rows[0]?.form_submissions) && !shuttingDown;
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
void runNotificationOutbox(() => shuttingDown);
while (!shuttingDown) {
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: commandTopics(), fromBeginning: false });
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
    break;
  } catch (error) {
    kafkaReady = false;
    if (shuttingDown) break;
    console.error("Kafka worker connection failed; retrying in 5 seconds", error);
    await consumer.disconnect().catch(() => undefined);
    await delay(5000);
  }
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import type { CommandAction, CrmCommand, EntityType } from "./types.js";
import { cacheGet, cacheSet, entityCacheKey } from "./cache.js";

export interface QueueInput {
  tenantId: string; provider: string; action: CommandAction; entityType?: string; entityId?: string;
  payload: Record<string, unknown>; idempotencyKey: string; correlationId: string;
}

interface OperationIdentity { id: string; status: string; entity_id: string | null; action: CommandAction; entity_type: string | null; request: Record<string, unknown> }

export async function queueOperation(input: QueueInput): Promise<{ id: string; status: string; entityId?: string; duplicate: boolean }> {
  return inTransaction(async (client) => {
    const operationId = randomUUID();
    const commandId = randomUUID();
    const inserted = await client.query<OperationIdentity>(
      `INSERT INTO crm_operations (id, tenant_id, provider, action, entity_type, entity_id, status, idempotency_key, correlation_id, request)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id,status,entity_id,action,entity_type,request`,
      [operationId, input.tenantId, input.provider, input.action, input.entityType ?? null, input.entityId ?? null, input.idempotencyKey, input.correlationId, input.payload]
    );
    if (!inserted.rowCount) {
      const existing = await client.query<OperationIdentity>(
        "SELECT id,status,entity_id,action,entity_type,request FROM crm_operations WHERE tenant_id=$1 AND idempotency_key=$2",
        [input.tenantId, input.idempotencyKey]
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Idempotency conflict could not be resolved");
      const sameTarget = input.action === "create" || row.entity_id === (input.entityId ?? null);
      if (row.action !== input.action || row.entity_type !== (input.entityType ?? null) || !sameTarget || !isDeepStrictEqual(row.request, input.payload)) {
        throw Object.assign(new Error("Idempotency-Key was already used for a different request"), { status: 409 });
      }
      return { id: row.id, status: row.status, entityId: row.entity_id ?? undefined, duplicate: true };
    }
    const command: CrmCommand = { schemaVersion: 1, id: commandId, operationId, tenantId: input.tenantId, provider: input.provider,
      action: input.action, entityType: input.entityType, entityId: input.entityId, payload: input.payload,
      correlationId: input.correlationId, requestedAt: new Date().toISOString() };
    await client.query("INSERT INTO crm_outbox (id, aggregate_id, topic, message_key, payload) VALUES ($1,$2,$3,$4,$5)",
      [commandId, operationId, config().KAFKA_COMMAND_TOPIC, input.tenantId, command]);
    return { id: operationId, status: "queued", entityId: input.entityId, duplicate: false };
  });
}

function entityResponse(row: Record<string, unknown>) {
  return {
    id: row.id, type: row.entity_type, provider: row.provider, provider_id: row.provider_id,
    properties: row.properties, associations: row.associations, version: Number(row.version),
    created_at: row.created_at, updated_at: row.updated_at
  };
}

function operationResponse(row: Record<string, unknown>) {
  return {
    id: row.id, provider: row.provider, action: row.action, entity_type: row.entity_type, entity_id: row.entity_id,
    status: row.status, result: row.result, error: row.error, attempts: row.attempts,
    correlation_id: row.correlation_id, created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at
  };
}

export async function getOperation(tenantId: string, id: string) {
  const result = await pool.query("SELECT * FROM crm_operations WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  return result.rows[0] ? operationResponse(result.rows[0]) : null;
}
export async function getEntity(tenantId: string, type: EntityType, id: string) {
  const key = entityCacheKey(tenantId, type, id);
  const cached = await cacheGet<ReturnType<typeof entityResponse>>(key);
  if (cached) return cached;
  const result = await pool.query("SELECT * FROM crm_entities WHERE tenant_id=$1 AND entity_type=$2 AND id=$3 AND deleted_at IS NULL", [tenantId, type, id]);
  const value = result.rows[0] ? entityResponse(result.rows[0]) : null;
  if (value) await cacheSet(key, value);
  return value;
}
export async function listEntities(tenantId: string, type: EntityType, limit: number, cursor?: string) {
  const params: unknown[] = [tenantId, type, limit + 1];
  const cursorClause = cursor ? "AND id > $4" : "";
  if (cursor) params.push(cursor);
  const result = await pool.query(`SELECT * FROM crm_entities WHERE tenant_id=$1 AND entity_type=$2 AND deleted_at IS NULL ${cursorClause} ORDER BY id LIMIT $3`, params);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map(entityResponse);
  return { items, nextCursor: hasMore ? rows.at(-1)?.id as string : undefined };
}
export async function claimOutbox(client: pg.PoolClient, limit = 100) {
  const result = await client.query(
    `SELECT id, topic, message_key, payload FROM crm_outbox WHERE published_at IS NULL AND available_at <= now()
     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
  return result.rows as Array<{ id: string; topic: string; message_key: string; payload: unknown }>;
}

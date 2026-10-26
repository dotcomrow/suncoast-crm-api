import type { PoolClient } from "pg";
import { cacheDelete, entityCacheKey } from "./cache.js";
import { config } from "./config.js";
import { inTransaction } from "./db.js";

export interface ContactPurgeResult {
  provider_id: string;
  entity_id: string | null;
  local: {
    subjects: number;
    email_addresses: number;
    verifications: number;
    custom_records: number;
    operations: number;
    outbox: number;
    entities: number;
  };
}

async function ids(client: PoolClient, sql: string, values: unknown[]): Promise<string[]> {
  const result = await client.query(sql, values);
  return result.rows.map((row) => String(row.id));
}

export async function purgeContactByProviderId(providerId: string): Promise<ContactPurgeResult> {
  const cfg = config();
  const result = await inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [cfg.CRM_TENANT_ID, `contact-purge:${providerId}`]);
    const entityResult = await client.query(
      `SELECT * FROM crm_entities
       WHERE tenant_id=$1 AND provider=$2 AND entity_type='contacts' AND provider_id=$3
       FOR UPDATE`,
      [cfg.CRM_TENANT_ID, cfg.CRM_PROVIDER, providerId]
    );
    const entity = entityResult.rows[0];

    if (!entity) {
      return {
        provider_id: providerId,
        entity_id: null,
        local: { subjects: 0, email_addresses: 0, verifications: 0, custom_records: 0, operations: 0, outbox: 0, entities: 0 }
      } satisfies ContactPurgeResult;
    }

    const entityId = String(entity.id);
    const customRecordIds = await ids(
      client,
      "SELECT id FROM crm_custom_object_records WHERE tenant_id=$1 AND contact_id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );
    const contactEmailIds = await ids(
      client,
      "SELECT id FROM crm_contact_emails WHERE tenant_id=$1 AND entity_id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );
    const verificationIds = await ids(
      client,
      `SELECT id FROM crm_email_verifications
       WHERE tenant_id=$1 AND (entity_id=$2 OR contact_email_id=ANY($3::uuid[]))
       FOR UPDATE`,
      [cfg.CRM_TENANT_ID, entityId, contactEmailIds]
    );
    const operationResult = await client.query(
      `SELECT id,status FROM crm_operations
       WHERE tenant_id=$1 AND (entity_id=$2 OR entity_id=ANY($3::uuid[]))
       FOR UPDATE`,
      [cfg.CRM_TENANT_ID, entityId, customRecordIds]
    );
    if (operationResult.rows.some((row) => row.status === "processing")) {
      throw Object.assign(new Error("The contact has an operation in progress; retry the purge shortly"), { status: 409 });
    }
    const operationIds = operationResult.rows.map((row) => String(row.id));
    const relatedEntityIds = [entityId, ...customRecordIds];

    const outbox = await client.query(
      `DELETE FROM crm_outbox
       WHERE aggregate_id=ANY($1::uuid[])
          OR aggregate_id=ANY($2::uuid[])
          OR payload->>'entityId'=ANY($3::text[])`,
      [operationIds, verificationIds, relatedEntityIds]
    );
    const customRecords = await client.query(
      "DELETE FROM crm_custom_object_records WHERE tenant_id=$1 AND contact_id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );
    const verifications = await client.query(
      `DELETE FROM crm_email_verifications
       WHERE tenant_id=$1 AND (entity_id=$2 OR contact_email_id=ANY($3::uuid[]))`,
      [cfg.CRM_TENANT_ID, entityId, contactEmailIds]
    );
    const emails = await client.query(
      "DELETE FROM crm_contact_emails WHERE tenant_id=$1 AND entity_id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );
    const subjects = await client.query(
      "DELETE FROM crm_contact_subjects WHERE tenant_id=$1 AND entity_id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );
    const operations = await client.query(
      `DELETE FROM crm_operations
       WHERE tenant_id=$1 AND (entity_id=$2 OR entity_id=ANY($3::uuid[]))`,
      [cfg.CRM_TENANT_ID, entityId, customRecordIds]
    );
    const entities = await client.query(
      "DELETE FROM crm_entities WHERE tenant_id=$1 AND entity_type='contacts' AND id=$2",
      [cfg.CRM_TENANT_ID, entityId]
    );

    return {
      provider_id: providerId,
      entity_id: entityId,
      local: {
        subjects: subjects.rowCount ?? 0,
        email_addresses: emails.rowCount ?? 0,
        verifications: verifications.rowCount ?? 0,
        custom_records: customRecords.rowCount ?? 0,
        operations: operations.rowCount ?? 0,
        outbox: outbox.rowCount ?? 0,
        entities: entities.rowCount ?? 0
      }
    } satisfies ContactPurgeResult;
  });

  if (result.entity_id) await cacheDelete(entityCacheKey(cfg.CRM_TENANT_ID, "contacts", result.entity_id));
  console.info("Contact purge completed", result);
  return result;
}

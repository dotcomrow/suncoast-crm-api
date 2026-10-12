import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import type { CrmCommand } from "./types.js";

const formName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const fieldValue = z.union([z.string(), z.number(), z.boolean()]).transform(String);

export const formSubmissionBody = z.object({
  fields: z.record(z.string().min(1).max(100), fieldValue).refine((fields) => Object.keys(fields).length > 0, "At least one field is required"),
  context: z.object({
    page_uri: z.string().url().max(2048).optional(),
    page_name: z.string().max(255).optional(),
    hutk: z.string().max(255).optional()
  }).optional(),
  consent: z.object({
    consent_to_process: z.literal(true),
    text: z.string().min(1).max(2000),
    communications: z.array(z.object({
      value: z.literal(true),
      subscription_type_id: z.number().int().positive(),
      text: z.string().min(1).max(2000)
    })).min(1)
  }).optional()
});

export type FormSubmissionBody = z.infer<typeof formSubmissionBody>;

export function configuredForm(form: string): { name: string; portalId: string; formId: string } {
  const name = formName.parse(form);
  const cfg = config();
  const formId = cfg.HUBSPOT_FORM_IDS[name];
  if (!formId) throw Object.assign(new Error(`Form '${name}' is not configured`), { status: 404 });
  if (!cfg.HUBSPOT_PORTAL_ID) throw Object.assign(new Error("HUBSPOT_PORTAL_ID is not configured"), { status: 503 });
  return { name, portalId: cfg.HUBSPOT_PORTAL_ID, formId };
}

export async function queueFormSubmission(input: {
  tenantId: string; provider: string; formName: string; formId: string; portalId: string;
  body: FormSubmissionBody; idempotencyKey: string; correlationId: string;
}): Promise<{ id: string; status: string; submissionId: string; duplicate: boolean }> {
  return await inTransaction(async (client) => {
    const existing = await client.query(
      "SELECT id,status,entity_id,action,entity_type,request FROM crm_operations WHERE tenant_id=$1 AND idempotency_key=$2",
      [input.tenantId, input.idempotencyKey]
    );
    const request = { form_name: input.formName, form_id: input.formId, portal_id: input.portalId, ...input.body };
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.action !== "form.submit" || row.entity_type !== input.formName || !isDeepStrictEqual(row.request, request)) {
        throw Object.assign(new Error("Idempotency-Key was already used for a different request"), { status: 409 });
      }
      return { id: String(row.id), status: String(row.status), submissionId: String(row.entity_id), duplicate: true };
    }

    const operationId = randomUUID();
    const submissionId = randomUUID();
    const commandId = randomUUID();
    await client.query(
      `INSERT INTO crm_operations (id,tenant_id,provider,action,entity_type,entity_id,status,idempotency_key,correlation_id,request)
       VALUES ($1,$2,$3,'form.submit',$4,$5,'queued',$6,$7,$8)`,
      [operationId, input.tenantId, input.provider, input.formName, submissionId, input.idempotencyKey, input.correlationId, request]
    );
    await client.query(
      `INSERT INTO crm_form_submissions (id,tenant_id,operation_id,provider,form_name,provider_form_id,email,fields,context,consent,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued')`,
      [submissionId, input.tenantId, operationId, input.provider, input.formName, input.formId,
        typeof input.body.fields.email === "string" ? input.body.fields.email : null,
        input.body.fields, input.body.context ?? {}, input.body.consent ?? null]
    );
    const command: CrmCommand = {
      schemaVersion: 1, id: commandId, operationId, tenantId: input.tenantId, provider: input.provider,
      action: "form.submit", entityType: input.formName, entityId: submissionId, payload: request,
      correlationId: input.correlationId, requestedAt: new Date().toISOString()
    };
    await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)",
      [commandId, operationId, config().KAFKA_COMMAND_TOPIC, input.tenantId, command]);
    return { id: operationId, status: "queued", submissionId, duplicate: false };
  });
}

export async function getFormSubmission(tenantId: string, id: string) {
  const result = await pool.query(
    `SELECT id,provider,form_name,provider_form_id,email,fields,context,consent,status,provider_response,error,submitted_at,created_at,updated_at
     FROM crm_form_submissions WHERE tenant_id=$1 AND id=$2`, [tenantId, id]
  );
  return result.rows[0] ?? null;
}

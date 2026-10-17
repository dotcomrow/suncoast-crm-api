import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { configuredForm, formSubmissionBody, queueFormSubmission } from "./forms.js";
import { providerFor } from "./providers/registry.js";

export const emailValidationBody = formSubmissionBody.extend({
  email: z.string().trim().email().max(320),
  purpose: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  user_id: z.string().trim().min(1).max(255).optional()
}).omit({ fields: true }).extend({
  fields: z.record(z.string().min(1).max(100), z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional()
});

export type EmailValidationBody = z.infer<typeof emailValidationBody>;

export async function queueEmailValidation(input: EmailValidationBody & { tenantId: string; provider: string; idempotencyKey: string; correlationId: string }) {
  const form = configuredForm(input.purpose);
  const body = {
    fields: { ...(input.fields ?? {}), email: input.email.toLowerCase() },
    context: input.context,
    consent: input.consent
  };
  const queued = await queueFormSubmission({ ...input, formName: form.name, formId: form.formId, portalId: form.portalId, body });
  const candidateId = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO crm_email_validations (id,tenant_id,form_submission_id,provider,email,purpose,user_id,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT (form_submission_id) DO NOTHING RETURNING id`,
    [candidateId, input.tenantId, queued.submissionId, input.provider, input.email.toLowerCase(), input.purpose, input.user_id ?? null]
  );
  const validationId = inserted.rows[0]?.id ? String(inserted.rows[0].id) : String((await pool.query(
    "SELECT id FROM crm_email_validations WHERE tenant_id=$1 AND form_submission_id=$2", [input.tenantId, queued.submissionId]
  )).rows[0].id);
  return { ...queued, validationId };
}

export async function getEmailValidation(tenantId: string, id: string, refresh: boolean) {
  const current = await pool.query(
    `SELECT id,tenant_id,form_submission_id,provider,email,purpose,user_id,status,provider_status,provider_contact_id,validated_at,completed_at,checked_at,action_plan,rule_set_version,created_at,updated_at
     FROM crm_email_validations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]
  );
  if (!current.rowCount || !refresh || current.rows[0].status !== "pending") return current.rows[0] ?? null;
  const provider = providerFor(String(current.rows[0].provider));
  if (!provider.getEmailValidation) throw Object.assign(new Error(`Provider ${provider.name} does not support email validation`), { status: 501 });
  const result = await provider.getEmailValidation(String(current.rows[0].email));
  if (result.status === "validated") {
    const { completeEmailValidation } = await import("./email-validation-rules.js");
    return await completeEmailValidation(current.rows[0], result);
  }
  const updated = await pool.query(`UPDATE crm_email_validations SET provider_status=$2,provider_contact_id=$3,checked_at=now(),updated_at=now()
    WHERE tenant_id=$1 AND id=$4 RETURNING id,tenant_id,form_submission_id,provider,email,purpose,user_id,status,provider_status,provider_contact_id,validated_at,completed_at,checked_at,action_plan,rule_set_version,created_at,updated_at`,
    [tenantId, result.providerStatus, result.providerContactId ?? null, id]);
  return updated.rows[0] ?? null;
}

export function emailValidationUrl(id: string): string {
  return `${config().OPENAPI_SERVER_URL.replace(/\/$/, "")}/v1/email-validations/${id}`;
}

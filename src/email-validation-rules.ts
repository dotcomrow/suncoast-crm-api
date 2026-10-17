import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import type { EmailValidationResult } from "./providers/provider.js";

const actionName = z.string().regex(/^[a-z][a-z0-9_.-]{0,126}$/);
const actionConfigBody = z.object({
  purpose: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  success_actions: z.array(actionName).max(50).default([]),
  failure_actions: z.array(actionName).max(50).default([]),
  expired_actions: z.array(actionName).max(50).default([])
});
export { actionConfigBody };
export const terminalOutcomeBody = z.object({ outcome: z.enum(["failed", "expired"]), reason: z.string().trim().min(1).max(1000) });

export interface RuleInput {
  validationId: string; userId?: string; purpose: string; outcome: "VALIDATED" | "FAILED" | "EXPIRED";
  mandatoryActions: string[]; defaultActions: string[]; userActions: string[]; approvedActions: string[];
}
export interface RuleDecision { accepted: boolean; reason: string; ruleSetVersion: string; actions: string[]; rejectedActions: string[]; }

const decisionSchema = z.object({ accepted: z.boolean(), reason: z.string(), ruleSetVersion: z.string(), actions: z.array(actionName), rejectedActions: z.array(z.string()) });

export function parseKieDecision(payload: unknown): RuleDecision {
  const results = (payload as any)?.result?.["execution-results"]?.results;
  const entry = Array.isArray(results) ? results.find((item) => item?.key === "decisions") : undefined;
  const values = Array.isArray(entry?.value) ? entry.value : [];
  const wrapped = values.map((value: Record<string, unknown>) => value?.["com.dotcomrow.rules.emailvalidation.EmailValidationDecision"]).find(Boolean);
  if (!wrapped) throw new Error("KIE response did not contain an email validation decision");
  return decisionSchema.parse(wrapped);
}

export async function evaluateEmailValidationActions(input: RuleInput): Promise<RuleDecision> {
  const cfg = config();
  if (!cfg.EMAIL_VALIDATION_RULES_ENABLED) throw Object.assign(new Error("Email validation rules are not enabled"), { status: 503 });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), cfg.KIE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cfg.KIE_SERVER_BASE_URL.replace(/\/$/, "")}/containers/instances/${encodeURIComponent(cfg.KIE_EMAIL_VALIDATION_CONTAINER)}`, {
      method: "POST", signal: controller.signal, headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ lookup: cfg.KIE_EMAIL_VALIDATION_SESSION, commands: [
        { insert: { object: { "com.dotcomrow.rules.emailvalidation.EmailValidationRequest": input }, "out-identifier": "request" } },
        { "fire-all-rules": {} },
        { "get-objects": { "out-identifier": "decisions", "object-filter": "com.dotcomrow.rules.emailvalidation.EmailValidationDecision" } }
      ] })
    });
    if (!response.ok) throw new Error(`KIE Server ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const decision = parseKieDecision(await response.json());
    if (!decision.accepted) throw Object.assign(new Error(`Email validation action plan rejected: ${decision.reason} (${decision.rejectedActions.join(", ")})`), { status: 502 });
    return decision;
  } finally { clearTimeout(timeout); }
}

async function actionFacts(tenantId: string, purpose: string, userId: string | null, outcome: string) {
  const approved = await pool.query("SELECT action_name FROM crm_email_validation_action_registry WHERE tenant_id=$1 AND enabled=true ORDER BY action_name", [tenantId]);
  const defaults = await pool.query(`SELECT action_name,mandatory FROM crm_email_validation_action_defaults
    WHERE tenant_id=$1 AND purpose IN ('*',$2) AND outcome=$3 AND enabled=true ORDER BY mandatory DESC,purpose,position,action_name`, [tenantId, purpose, outcome]);
  const custom = userId ? await pool.query(`SELECT action_name FROM crm_email_validation_user_actions
    WHERE tenant_id=$1 AND user_id=$2 AND purpose=$3 AND outcome=$4 AND enabled=true ORDER BY position,action_name`, [tenantId, userId, purpose, outcome]) : { rows: [] };
  return {
    approvedActions: approved.rows.map((row) => String(row.action_name)),
    mandatoryActions: defaults.rows.filter((row) => row.mandatory).map((row) => String(row.action_name)),
    defaultActions: defaults.rows.filter((row) => !row.mandatory).map((row) => String(row.action_name)),
    userActions: custom.rows.map((row) => String(row.action_name))
  };
}

async function completeOutcome(row: any, outcome: "VALIDATED" | "FAILED" | "EXPIRED", detail: { providerStatus?: string | null; providerContactId?: string | null; reason?: string }) {
  const tenantId = String(row.tenant_id ?? config().CRM_TENANT_ID);
  const facts = await actionFacts(tenantId, String(row.purpose), row.user_id ? String(row.user_id) : null, outcome);
  const decision = await evaluateEmailValidationActions({ validationId: String(row.id), userId: row.user_id ? String(row.user_id) : undefined, purpose: String(row.purpose), outcome, ...facts });
  const status = outcome.toLowerCase();
  return await inTransaction(async (client) => {
    const updated = await client.query(`UPDATE crm_email_validations SET status=$2,provider_status=COALESCE($3,provider_status),provider_contact_id=COALESCE($4,provider_contact_id),
      checked_at=now(),completed_at=COALESCE(completed_at,now()),validated_at=CASE WHEN $2='validated' THEN COALESCE(validated_at,now()) ELSE validated_at END,
      action_plan=$5,rule_set_version=$6,updated_at=now()
      WHERE tenant_id=$1 AND id=$7 AND status='pending'
      RETURNING id,form_submission_id,provider,email,purpose,user_id,status,provider_status,provider_contact_id,validated_at,completed_at,checked_at,action_plan,rule_set_version,created_at,updated_at`,
      [tenantId, status, detail.providerStatus ?? null, detail.providerContactId ?? null, decision.actions, decision.ruleSetVersion, row.id]);
    if (!updated.rowCount) return (await client.query("SELECT * FROM crm_email_validations WHERE tenant_id=$1 AND id=$2", [tenantId, row.id])).rows[0] ?? null;
    const base = { schemaVersion: 1, validationId: row.id, userId: row.user_id ?? null, email: row.email, purpose: row.purpose, outcome, reason: detail.reason ?? null, ruleSetVersion: decision.ruleSetVersion, occurredAt: new Date().toISOString() };
    await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), row.id, config().KAFKA_EMAIL_VALIDATION_EVENT_TOPIC, row.id, { ...base, type: `crm.email-validation.${status}` }]);
    for (const action of decision.actions) await client.query("INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), row.id, config().KAFKA_EMAIL_VALIDATION_ACTION_TOPIC, row.id, { ...base, type: "crm.email-validation.action.requested", action, idempotencyKey: `${row.id}:${outcome}:${action}` }]);
    return updated.rows[0];
  });
}

export async function completeEmailValidation(row: any, provider: EmailValidationResult) {
  return await completeOutcome(row, "VALIDATED", { providerStatus: provider.providerStatus, providerContactId: provider.providerContactId });
}

export async function completeEmailValidationTerminal(tenantId: string, id: string, outcome: "failed" | "expired", reason: string) {
  const result = await pool.query("SELECT * FROM crm_email_validations WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rowCount) return null;
  return await completeOutcome(result.rows[0], outcome.toUpperCase() as "FAILED" | "EXPIRED", { reason });
}

export async function getUserActionConfig(tenantId: string, userId: string) {
  const result = await pool.query("SELECT purpose,outcome,action_name,position FROM crm_email_validation_user_actions WHERE tenant_id=$1 AND user_id=$2 AND enabled=true ORDER BY purpose,outcome,position,action_name", [tenantId, userId]);
  return result.rows;
}

export async function putUserActionConfig(tenantId: string, userId: string, body: z.infer<typeof actionConfigBody>) {
  return await inTransaction(async (client) => {
    const requested = [...new Set([...body.success_actions, ...body.failure_actions, ...body.expired_actions])];
    if (requested.length) {
      const registered = await client.query("SELECT action_name FROM crm_email_validation_action_registry WHERE tenant_id=$1 AND enabled=true AND action_name=ANY($2::text[])", [tenantId, requested]);
      const known = new Set(registered.rows.map((row) => String(row.action_name)));
      const unknown = requested.filter((action) => !known.has(action));
      if (unknown.length) throw Object.assign(new Error(`Unknown or disabled email validation actions: ${unknown.join(", ")}`), { status: 400 });
    }
    await client.query("DELETE FROM crm_email_validation_user_actions WHERE tenant_id=$1 AND user_id=$2 AND purpose=$3", [tenantId, userId, body.purpose]);
    const groups = [["VALIDATED", body.success_actions], ["FAILED", body.failure_actions], ["EXPIRED", body.expired_actions]] as const;
    for (const [outcome, actions] of groups) for (const [position, action] of actions.entries()) await client.query(
      "INSERT INTO crm_email_validation_user_actions (tenant_id,user_id,purpose,outcome,action_name,position) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, userId, body.purpose, outcome, action, position]);
    return (await client.query("SELECT purpose,outcome,action_name,position FROM crm_email_validation_user_actions WHERE tenant_id=$1 AND user_id=$2 AND enabled=true ORDER BY purpose,outcome,position,action_name", [tenantId, userId])).rows;
  });
}

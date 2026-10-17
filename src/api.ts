import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { openApiSpec } from "./openapi.js";
import { runOutbox, stopOutbox } from "./outbox.js";
import { getEntity, getOperation, listEntities, queueOperation } from "./repository.js";
import { assertContact, assertCustomRecordCardinality, customRecordBody, customRecordUpdateBody, getCustomObjectDefinition, getCustomRecord, listCustomObjectDefinitions, listCustomRecords, validateCustomProperties } from "./custom-objects.js";
import { aiBody, entityBody, updateBody } from "./validation.js";
import { entityTypes, type EntityType } from "./types.js";
import { configuredForm, formSubmissionBody, getFormSubmission, queueFormSubmission } from "./forms.js";
import { emailValidationBody, emailValidationUrl, getEmailValidation, queueEmailValidation } from "./email-validations.js";
import { actionConfigBody, completeEmailValidationTerminal, getUserActionConfig, putUserActionConfig, terminalOutcomeBody } from "./email-validation-rules.js";

const app = express();
app.disable("x-powered-by"); app.use(helmet()); app.use(express.json({ limit: "1mb" }));
const typeOf = (value: string): EntityType => { if (!(entityTypes as readonly string[]).includes(value)) throw Object.assign(new Error("Unsupported entity type"), { status: 404 }); return value as EntityType; };
const headers = (req: Request) => {
  const tenantId = config().CRM_TENANT_ID; const idempotencyKey = req.header("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8) throw Object.assign(new Error("Idempotency-Key of at least 8 characters is required"), { status: 400 });
  return { tenantId, idempotencyKey, correlationId: req.header("X-Correlation-ID")?.trim() || randomUUID() };
};
const tenant = () => config().CRM_TENANT_ID;
const queuedResponse = (result: { id: string; status: string; duplicate: boolean }) => ({ operation_id: result.id, status: result.status, duplicate: result.duplicate, status_url: `${config().OPENAPI_SERVER_URL.replace(/\/$/, "")}/v1/operations/${result.id}` });

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz", async (_req, res) => { try { const result = await pool.query("SELECT to_regclass('crm_operations') AS operations, to_regclass('crm_outbox') AS outbox, to_regclass('crm_custom_object_definitions') AS custom_definitions, to_regclass('crm_custom_object_records') AS custom_records, to_regclass('crm_form_submissions') AS form_submissions, to_regclass('crm_email_validations') AS email_validations, to_regclass('crm_email_validation_action_registry') AS action_registry, to_regclass('crm_email_validation_action_defaults') AS action_defaults, to_regclass('crm_email_validation_user_actions') AS user_actions"); const row = result.rows[0]; if (!row?.operations || !row?.outbox || !row?.custom_definitions || !row?.custom_records || !row?.form_submissions || !row?.email_validations || !row?.action_registry || !row?.action_defaults || !row?.user_actions) throw new Error("CRM schema is not migrated"); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
app.get("/openapi.json", (_req, res) => res.json(openApiSpec()));
app.get("/v1/operations/:operationId", async (req, res) => { const value = await getOperation(tenant(), req.params.operationId!); value ? res.json(value) : res.status(404).json({ error: "Operation not found" }); });
app.get("/v1/form-submissions/:submissionId", async (req, res) => { const value = await getFormSubmission(tenant(), req.params.submissionId!); value ? res.json(value) : res.status(404).json({ error: "Form submission not found" }); });
app.post("/v1/forms/:formName/submissions", async (req, res) => {
  const h = headers(req); const form = configuredForm(req.params.formName!); const body = formSubmissionBody.parse(req.body);
  const result = await queueFormSubmission({ ...h, provider: config().CRM_PROVIDER, formName: form.name, formId: form.formId, portalId: form.portalId, body });
  return res.status(202).json({ ...queuedResponse(result), submission_id: result.submissionId, submission_url: `${config().OPENAPI_SERVER_URL.replace(/\/$/, "")}/v1/form-submissions/${result.submissionId}` });
});
app.post("/v1/email-validations", async (req, res) => {
  const h = headers(req); const body = emailValidationBody.parse(req.body);
  const result = await queueEmailValidation({ ...h, ...body, provider: config().CRM_PROVIDER });
  return res.status(202).json({ validation_id: result.validationId, status: "pending", duplicate: result.duplicate, status_url: emailValidationUrl(result.validationId), operation_id: result.id, form_submission_id: result.submissionId });
});
app.get("/v1/email-validations/:validationId", async (req, res) => {
  const value = await getEmailValidation(tenant(), req.params.validationId!, req.query.refresh !== "false");
  return value ? res.json(value) : res.status(404).json({ error: "Email validation not found" });
});
app.post("/v1/email-validations/:validationId/outcome", async (req, res) => {
  headers(req); const body = terminalOutcomeBody.parse(req.body); const value = await completeEmailValidationTerminal(tenant(), req.params.validationId!, body.outcome, body.reason);
  return value ? res.json(value) : res.status(404).json({ error: "Email validation not found" });
});
app.get("/v1/email-validation-action-config/users/:userId", async (req, res) => res.json(await getUserActionConfig(tenant(), req.params.userId!)));
app.put("/v1/email-validation-action-config/users/:userId", async (req, res) => { headers(req); return res.json(await putUserActionConfig(tenant(), req.params.userId!, actionConfigBody.parse(req.body))); });
app.get("/v1/custom-objects", async (_req, res) => res.json(await listCustomObjectDefinitions(tenant())));
app.get("/v1/custom-objects/:objectName", async (req, res) => { const value = await getCustomObjectDefinition(tenant(), req.params.objectName!); value ? res.json(value) : res.status(404).json({ error: "Custom object not found" }); });
app.get("/v1/custom-objects/:objectName/records", async (req, res) => { const definition = await getCustomObjectDefinition(tenant(), req.params.objectName!); if (!definition) return res.status(404).json({ error: "Custom object not found" }); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)); return res.json(await listCustomRecords(tenant(), definition.name, limit, typeof req.query.cursor === "string" ? req.query.cursor : undefined, typeof req.query.contact_id === "string" ? req.query.contact_id : undefined)); });
app.get("/v1/custom-objects/:objectName/records/:recordId", async (req, res) => { const value = await getCustomRecord(tenant(), req.params.objectName!, req.params.recordId!); value ? res.json(value) : res.status(404).json({ error: "Custom object record not found" }); });
app.post("/v1/custom-objects/:objectName/records", async (req, res) => { const h = headers(req); const definition = await getCustomObjectDefinition(h.tenantId, req.params.objectName!); if (!definition) return res.status(404).json({ error: "Custom object not found" }); const body = customRecordBody.parse(req.body); validateCustomProperties(definition, body.properties); await assertContact(h.tenantId, body.contact_id); await assertCustomRecordCardinality(h.tenantId, definition, body.contact_id); const recordId = randomUUID(); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "custom.create", entityType: definition.name, entityId: recordId, payload: { ...body, definition_id: definition.id } }); return res.status(202).json({ ...queuedResponse(result), record_id: result.entityId }); });
app.patch("/v1/custom-objects/:objectName/records/:recordId", async (req, res) => { const h = headers(req); const definition = await getCustomObjectDefinition(h.tenantId, req.params.objectName!); if (!definition) return res.status(404).json({ error: "Custom object not found" }); const existing = await getCustomRecord(h.tenantId, definition.name, req.params.recordId!); if (!existing) return res.status(404).json({ error: "Custom object record not found" }); const body = customRecordUpdateBody.parse(req.body); validateCustomProperties(definition, body.properties, true); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "custom.update", entityType: definition.name, entityId: req.params.recordId!, payload: body }); return res.status(202).json(queuedResponse(result)); });
app.delete("/v1/custom-objects/:objectName/records/:recordId", async (req, res) => { const h = headers(req); const definition = await getCustomObjectDefinition(h.tenantId, req.params.objectName!); if (!definition) return res.status(404).json({ error: "Custom object not found" }); const existing = await getCustomRecord(h.tenantId, definition.name, req.params.recordId!); if (!existing) return res.status(404).json({ error: "Custom object record not found" }); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "custom.delete", entityType: definition.name, entityId: req.params.recordId!, payload: {} }); return res.status(202).json(queuedResponse(result)); });
app.get("/v1/:entityType/:entityId", async (req, res) => { const value = await getEntity(tenant(), typeOf(req.params.entityType!), req.params.entityId!); value ? res.json(value) : res.status(404).json({ error: "Entity not found" }); });
app.get("/v1/:entityType", async (req, res) => { const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)); res.json(await listEntities(tenant(), typeOf(req.params.entityType!), limit, typeof req.query.cursor === "string" ? req.query.cursor : undefined)); });
app.post("/v1/:entityType", async (req, res) => { const h = headers(req); const body = entityBody.parse(req.body); const entityId = randomUUID(); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "create", entityType: typeOf(req.params.entityType!), entityId, payload: body }); res.status(202).json({ ...queuedResponse(result), entity_id: result.entityId }); });
app.patch("/v1/:entityType/:entityId", async (req, res) => { const h = headers(req); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "update", entityType: typeOf(req.params.entityType!), entityId: req.params.entityId!, payload: updateBody.parse(req.body) }); res.status(202).json(queuedResponse(result)); });
app.delete("/v1/:entityType/:entityId", async (req, res) => { const h = headers(req); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "delete", entityType: typeOf(req.params.entityType!), entityId: req.params.entityId!, payload: {} }); res.status(202).json(queuedResponse(result)); });
app.post("/v1/ai/summaries", async (req, res) => { const h = headers(req); const body = aiBody.parse(req.body); const result = await queueOperation({ ...h, provider: config().CRM_PROVIDER, action: "ai.summarize", entityType: body.entity_type, entityId: body.entity_id, payload: body }); res.status(202).json(queuedResponse(result)); });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { if (error instanceof ZodError) return res.status(400).json({ error: "Invalid request", details: error.issues }); const value = error as { message?: string; status?: number }; console.error(error); return res.status(value.status ?? 500).json({ error: value.status ? value.message : "Internal server error" }); });

const server = app.listen(config().PORT, () => console.log(`CRM API listening on ${config().PORT}`));
void runOutbox();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopOutbox(); server.close(() => void pool.end().finally(() => process.exit(0))); });

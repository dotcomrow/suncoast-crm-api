import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { openApiSpec } from "./openapi.js";
import { runOutbox, stopOutbox } from "./outbox.js";
import { getEntity, getOperation, listEntities, queueOperation } from "./repository.js";
import { aiBody, entityBody, updateBody } from "./validation.js";
import { entityTypes, type EntityType } from "./types.js";

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
app.get("/readyz", async (_req, res) => { try { const result = await pool.query("SELECT to_regclass('crm_operations') AS operations, to_regclass('crm_outbox') AS outbox"); const row = result.rows[0]; if (!row?.operations || !row?.outbox) throw new Error("CRM schema is not migrated"); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
app.get("/openapi.json", (_req, res) => res.json(openApiSpec()));
app.get("/v1/operations/:operationId", async (req, res) => { const value = await getOperation(tenant(), req.params.operationId!); value ? res.json(value) : res.status(404).json({ error: "Operation not found" }); });
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

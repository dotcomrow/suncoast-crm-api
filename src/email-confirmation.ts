import { createHash, randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { cacheDelete, entityCacheKey } from "./cache.js";
import { inTransaction, pool } from "./db.js";
import { providerFor } from "./providers/registry.js";
import type { CrmEntity } from "./types.js";
import type { PoolClient } from "pg";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: "no-referrer" } }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

const codePattern = /^[A-Za-z0-9_-]{43,128}$/;
const hash = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");
const page = (title: string, message: string, form = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p>${form}</main></body></html>`;

const confirmationPaths = ["/", "/confirm-email", "/crm-email-confirmation", "/crm-email-confirmation/confirm-email"];

async function syncContactIndicator(client: PoolClient, verification: Record<string, unknown>, verifiedAt: string): Promise<string | null> {
  const entityResult = verification.entity_id
    ? await client.query("SELECT * FROM crm_entities WHERE tenant_id=$1 AND id=$2 AND entity_type='contacts' AND deleted_at IS NULL", [config().CRM_TENANT_ID, verification.entity_id])
    : await client.query(
      `SELECT * FROM crm_entities
       WHERE tenant_id=$1 AND entity_type='contacts' AND deleted_at IS NULL
         AND lower(COALESCE(properties->>'email',properties->>'emailAddress',''))=lower($2)
       ORDER BY created_at DESC LIMIT 2`, [config().CRM_TENANT_ID, verification.email]
    );
  if (!verification.entity_id && entityResult.rowCount !== 1) return null;
  const entityRow = entityResult.rows[0];
  if (!entityRow?.provider_id) throw new Error("The contact is not ready for confirmation; retry shortly");
  if (entityRow.properties?.email_verified === true && entityRow.properties?.email_verified_at === verifiedAt) return entityRow.id as string;
  const properties = { ...(entityRow.properties ?? {}), email_verified: true, email_verified_at: verifiedAt };
  const entity: CrmEntity = {
    id: entityRow.id, type: "contacts", provider: entityRow.provider, providerId: entityRow.provider_id,
    properties, associations: entityRow.associations ?? {}, version: Number(entityRow.version),
    createdAt: entityRow.created_at, updatedAt: verifiedAt
  };
  await providerFor(entityRow.provider).update("contacts", entityRow.provider_id, entity);
  await client.query(
    "UPDATE crm_entities SET properties=$2,version=version+1,updated_at=$3 WHERE tenant_id=$1 AND id=$4",
    [config().CRM_TENANT_ID, properties, verifiedAt, entityRow.id]
  );
  await cacheDelete(entityCacheKey(config().CRM_TENANT_ID, "contacts", entityRow.id));
  return entityRow.id as string;
}

async function reconcileVerifiedContactIndicators(): Promise<void> {
  const verified = await pool.query(
    `SELECT id FROM (
       SELECT id,entity_id,verified_at,
         row_number() OVER (PARTITION BY lower(email) ORDER BY verified_at DESC NULLS LAST,created_at DESC) AS email_rank
       FROM crm_email_verifications WHERE tenant_id=$1 AND status='verified'
     ) verified WHERE entity_id IS NOT NULL OR email_rank=1 ORDER BY verified_at`,
    [config().CRM_TENANT_ID]
  );
  for (const candidate of verified.rows) {
    await inTransaction(async (client) => {
      const selected = await client.query("SELECT * FROM crm_email_verifications WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [config().CRM_TENANT_ID, candidate.id]);
      const row = selected.rows[0];
      if (!row?.verified_at) return;
      const entityId = await syncContactIndicator(client, row, new Date(row.verified_at).toISOString());
      if (entityId && !row.entity_id) await client.query("UPDATE crm_email_verifications SET entity_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [config().CRM_TENANT_ID, row.id, entityId]);
    });
  }
}

app.get(confirmationPaths, (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!codePattern.test(code)) return res.status(400).type("html").send(page("Invalid confirmation link", "The confirmation code is not valid."));
  const escaped = code.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return res.status(200).type("html").send(page("Confirm your email", "Select Confirm to verify this email address.", `<form method="post"><input type="hidden" name="code" value="${escaped}"><button type="submit">Confirm</button></form>`));
});

app.post(confirmationPaths, async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!codePattern.test(code)) return res.status(400).type("html").send(page("Invalid confirmation code", "The confirmation code is not valid."));
  let result: Record<string, unknown> | null;
  try {
    result = await inTransaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM crm_email_verifications
         WHERE tenant_id=$1 AND token_hash=$2 AND status='pending' AND expires_at > now()
         FOR UPDATE`, [config().CRM_TENANT_ID, hash(code)]
      );
      const row = selected.rows[0];
      if (!row) return null;
      const verifiedAt = new Date().toISOString();

      if (row.entity_id) {
        await syncContactIndicator(client, row, verifiedAt);
      }

      const updated = await client.query(
        `UPDATE crm_email_verifications SET status='verified',verified_at=$3,updated_at=$3
         WHERE tenant_id=$1 AND id=$2 RETURNING id,email,entity_id,verified_at`,
        [config().CRM_TENANT_ID, row.id, verifiedAt]
      );
      const verified = updated.rows[0];
      await client.query(
        "INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)",
        [randomUUID(), verified.id, config().KAFKA_EMAIL_VALIDATION_EVENT_TOPIC, verified.id, {
          schemaVersion: 1, type: "crm.email-validation.validated", validationId: verified.id,
          entityId: verified.entity_id, email: verified.email, outcome: "VALIDATED", occurredAt: verified.verified_at
        }]
      );
      return verified;
    });
  } catch (error) {
    console.error("Email confirmation synchronization failed", error);
    return res.status(503).type("html").send(page("Confirmation temporarily unavailable", "The contact could not be updated. Please try this link again shortly."));
  }
  if (!result) return res.status(410).type("html").send(page("Link unavailable", "This confirmation link is invalid, expired, or already used."));
  return res.status(200).type("html").send(page("Email confirmed", "Your email address has been verified."));
});

app.use((_req, res) => res.status(404).type("text").send("Not found"));

const server = app.listen(config().EMAIL_CONFIRMATION_PORT, "0.0.0.0", () => console.log(`Email confirmation listener on ${config().EMAIL_CONFIRMATION_PORT}`));
void reconcileVerifiedContactIndicators().then(() => console.log("Reconciled verified Contact indicators")).catch((error) => console.error("Verified Contact indicator reconciliation failed", error));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => void pool.end().finally(() => process.exit(0))));

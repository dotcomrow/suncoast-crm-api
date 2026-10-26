import { createHash, randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { config } from "./config.js";
import { cacheDelete, entityCacheKey } from "./cache.js";
import { inTransaction, pool } from "./db.js";
import { kafka } from "./kafka.js";
import { providerFor } from "./providers/registry.js";
import { queueOperation } from "./repository.js";
import { externalContactProperties } from "./validation.js";
import type { PoolClient } from "pg";
import { getContactEmailForVerification, listContactEmails, setContactEmailProjection } from "./contact-emails.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: "no-referrer" } }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

const codePattern = /^[A-Za-z0-9_-]{43,128}$/;
const hash = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");
const page = (title: string, message: string, form = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p>${form}</main></body></html>`;

const confirmationPaths = ["/", "/confirm-email", "/crm-email-confirmation", "/crm-email-confirmation/confirm-email"];
const emailValidationEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.enum(["crm.email-validation.validated", "crm.email-validation.expired"]),
  validationId: z.string().uuid()
});
let shuttingDown = false;

async function syncContactEmailProjection(client: PoolClient, verification: Record<string, unknown>): Promise<string | null> {
  const contactEmail = await getContactEmailForVerification(client, config().CRM_TENANT_ID, String(verification.id));
  if (!contactEmail) return null;
  const entityResult = await client.query(
    "SELECT * FROM crm_entities WHERE tenant_id=$1 AND id=$2 AND entity_type='contacts' AND deleted_at IS NULL FOR UPDATE",
    [config().CRM_TENANT_ID, contactEmail.entityId]
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow?.provider_id) throw new Error("The contact is not ready for email projection; retry shortly");
  const provider = providerFor(entityRow.provider);
  if (!provider.syncContactEmail) throw new Error(`Provider ${entityRow.provider} does not support per-address email projection`);
  const written = await provider.syncContactEmail(entityRow.provider_id, contactEmail);
  await setContactEmailProjection(client, config().CRM_TENANT_ID, contactEmail.id, written.providerId);
  const emails = await listContactEmails(client, config().CRM_TENANT_ID, contactEmail.entityId);
  const primary = emails.find((candidate) => candidate.isPrimary) ?? emails[0];
  const properties = {
    ...(entityRow.properties ?? {}),
    email_addresses: emails.map((candidate) => ({
      id: candidate.id,
      email: candidate.email,
      primary: candidate.isPrimary,
      status: candidate.status,
      verified_at: candidate.verifiedAt
    })),
    ...(primary ? {
      email: primary.email,
      email_verified: primary.status === "verified",
      email_verified_at: primary.verifiedAt
    } : {})
  };
  await client.query(
    "UPDATE crm_entities SET properties=$2,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$3",
    [config().CRM_TENANT_ID, properties, entityRow.id]
  );
  await cacheDelete(entityCacheKey(config().CRM_TENANT_ID, "contacts", entityRow.id));
  return entityRow.id as string;
}

async function reconcileContactEmailProjections(): Promise<void> {
  const candidates = await pool.query(
    `SELECT current_verification_id AS id FROM crm_contact_emails
     WHERE tenant_id=$1 AND current_verification_id IS NOT NULL
       AND (projected_at IS NULL OR projected_at < updated_at)
     ORDER BY updated_at`,
    [config().CRM_TENANT_ID]
  );
  for (const candidate of candidates.rows) {
    try {
      await reconcileContactEmailProjection(candidate.id);
    } catch (error) {
      console.error(`Contact email projection failed for ${candidate.id}`, error);
    }
  }
}

async function recoverMissingNameContactOperations(): Promise<void> {
  const failed = await pool.query(
    `SELECT DISTINCT ON (op.id)
       op.id,op.provider,op.entity_id,op.idempotency_key,op.request,verification.id AS verification_id
     FROM crm_operations op
     JOIN crm_email_verifications verification
       ON verification.tenant_id=op.tenant_id AND verification.entity_id=op.entity_id
     WHERE op.tenant_id=$1
       AND op.action='create' AND op.entity_type='contacts' AND op.status='failed'
       AND verification.purpose='notifications' AND verification.status IN ('pending','verified')
       AND op.error ILIKE '%lastName%' AND op.error ILIKE '%required%'
     ORDER BY op.id,verification.created_at DESC`,
    [config().CRM_TENANT_ID]
  );
  for (const candidate of failed.rows) {
    try {
      const request = candidate.request && typeof candidate.request === "object" ? candidate.request as Record<string, unknown> : {};
      const rawProperties = request.properties && typeof request.properties === "object" ? request.properties as Record<string, unknown> : {};
      const rawAssociations = request.associations && typeof request.associations === "object" ? request.associations as Record<string, unknown> : {};
      await queueOperation({
        tenantId: config().CRM_TENANT_ID,
        provider: candidate.provider,
        action: "create",
        entityType: "contacts",
        entityId: candidate.entity_id,
        payload: { properties: externalContactProperties(rawProperties), associations: rawAssociations },
        idempotencyKey: candidate.idempotency_key,
        correlationId: `email-verification-recovery:${candidate.verification_id}`,
        retryFailed: true
      });
      console.log(`Requeued Contact operation ${candidate.id} after adding placeholder names`);
    } catch (error) {
      console.error(`Failed to recover Contact operation ${candidate.id}`, error);
    }
  }
}

async function reconcileContactEmailProjection(verificationId: string): Promise<void> {
  await inTransaction(async (client) => {
    const selected = await client.query(
      "SELECT * FROM crm_email_verifications WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [config().CRM_TENANT_ID, verificationId]
    );
    const row = selected.rows[0];
    if (!row) return;
    const entityId = await syncContactEmailProjection(client, row);
    if (entityId && !row.entity_id) {
      await client.query(
        "UPDATE crm_email_verifications SET entity_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [config().CRM_TENANT_ID, row.id, entityId]
      );
    }
  });
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
      const updated = await client.query(
        `UPDATE crm_email_verifications SET status='verified',verified_at=$3,updated_at=$3
         WHERE tenant_id=$1 AND id=$2 RETURNING id,email,entity_id,contact_email_id,verified_at`,
        [config().CRM_TENANT_ID, row.id, verifiedAt]
      );
      const verified = updated.rows[0];
      if (verified.contact_email_id) {
        await client.query(
          `UPDATE crm_contact_emails SET status='verified',verified_at=$4,updated_at=$4
           WHERE tenant_id=$1 AND id=$2 AND current_verification_id=$3`,
          [config().CRM_TENANT_ID, verified.contact_email_id, verified.id, verifiedAt]
        );
      }
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
    console.error("Email confirmation failed", error);
    return res.status(503).type("html").send(page("Confirmation temporarily unavailable", "Your email address could not be verified. Please try this link again shortly."));
  }
  if (!result) return res.status(410).type("html").send(page("Link unavailable", "This confirmation link is invalid, expired, or already used."));
  return res.status(200).type("html").send(page("Email confirmed", "Your email address has been verified."));
});

app.use((_req, res) => res.status(404).type("text").send("Not found"));

const server = app.listen(config().EMAIL_CONFIRMATION_PORT, "0.0.0.0", () => console.log(`Email confirmation listener on ${config().EMAIL_CONFIRMATION_PORT}`));
const consumer = kafka().consumer({ groupId: config().KAFKA_EMAIL_VALIDATION_CONSUMER_GROUP, retry: { retries: config().PROVIDER_MAX_ATTEMPTS } });

async function reconcileSafely(): Promise<void> {
  try {
    await recoverMissingNameContactOperations();
    await reconcileContactEmailProjections();
  } catch (error) {
    console.error("Contact email projection sweep failed", error);
  }
}

async function runEmailValidationConsumer(): Promise<void> {
  while (!shuttingDown) {
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: config().KAFKA_EMAIL_VALIDATION_EVENT_TOPIC, fromBeginning: false });
      console.log(`Email-validation projector subscribed to ${config().KAFKA_EMAIL_VALIDATION_EVENT_TOPIC}`);
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const parsedJson = (() => { try { return JSON.parse(message.value.toString()) as unknown; } catch { return null; } })();
          const parsed = emailValidationEventSchema.safeParse(parsedJson);
          if (!parsed.success) {
            console.error("Ignoring malformed email-validation event", parsed.error.message);
            return;
          }
          try {
            await reconcileContactEmailProjection(parsed.data.validationId);
          } catch (error) {
            // Commit the event and let the periodic database sweep retry it. This
            // prevents one permanently bad contact from blocking the partition.
            console.error(`Email-address projection deferred for ${parsed.data.validationId}`, error);
          }
        }
      });
      break;
    } catch (error) {
      if (shuttingDown) break;
      console.error("Email-validation consumer connection failed; retrying in 5 seconds", error);
      await consumer.disconnect().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

void reconcileSafely();
const reconciliationTimer = setInterval(() => void reconcileSafely(), config().EMAIL_VERIFICATION_RECONCILE_MS);
reconciliationTimer.unref();
void runEmailValidationConsumer();

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reconciliationTimer);
  await consumer.disconnect().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());

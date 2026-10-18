import { createHash, randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: "no-referrer" } }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

const codePattern = /^[A-Za-z0-9_-]{43,128}$/;
const hash = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");
const page = (title: string, message: string, form = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p>${form}</main></body></html>`;

const confirmationPaths = ["/", "/confirm-email", "/crm-email-confirmation", "/crm-email-confirmation/confirm-email"];

app.get(confirmationPaths, (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!codePattern.test(code)) return res.status(400).type("html").send(page("Invalid confirmation link", "The confirmation code is not valid."));
  const escaped = code.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return res.status(200).type("html").send(page("Confirm your email", "Select Confirm to verify this email address.", `<form method="post"><input type="hidden" name="code" value="${escaped}"><button type="submit">Confirm</button></form>`));
});

app.post(confirmationPaths, async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!codePattern.test(code)) return res.status(400).type("html").send(page("Invalid confirmation code", "The confirmation code is not valid."));
  const result = await inTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE crm_email_verifications SET status='verified',verified_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND token_hash=$2 AND status='pending' AND expires_at > now()
       RETURNING id,email,verified_at`, [config().CRM_TENANT_ID, hash(code)]
    );
    const row = updated.rows[0];
    if (!row) return null;
    await client.query(
      "INSERT INTO crm_outbox (id,aggregate_id,topic,message_key,payload) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), row.id, config().KAFKA_EMAIL_VALIDATION_EVENT_TOPIC, row.id, {
        schemaVersion: 1, type: "crm.email-validation.validated", validationId: row.id,
        email: row.email, outcome: "VALIDATED", occurredAt: row.verified_at
      }]
    );
    return row;
  });
  if (!result) return res.status(410).type("html").send(page("Link unavailable", "This confirmation link is invalid, expired, or already used."));
  return res.status(200).type("html").send(page("Email confirmed", "Your email address has been verified."));
});

app.use((_req, res) => res.status(404).type("text").send("Not found"));

const server = app.listen(config().EMAIL_CONFIRMATION_PORT, "0.0.0.0", () => console.log(`Email confirmation listener on ${config().EMAIL_CONFIRMATION_PORT}`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => void pool.end().finally(() => process.exit(0))));

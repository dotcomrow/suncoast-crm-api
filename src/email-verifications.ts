import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";

export const emailVerificationBody = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  purpose: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).default("external-signup")
});

function response(row: Record<string, unknown>) {
  return { id: row.id, validation_id: row.id, email: row.email, purpose: row.purpose, status: row.status, expires_at: row.expires_at, verified_at: row.verified_at, created_at: row.created_at };
}

async function queueConfirmationEmail(email: string, url: string, id: string): Promise<void> {
  const cfg = config();
  if (!cfg.PLATFORM_NOTIFICATION_TOKEN) throw Object.assign(new Error("Platform notification credential is unavailable"), { status: 503 });
  const result = await fetch(`${cfg.PLATFORM_NOTIFICATION_SERVICE_URL.replace(/\/$/, "")}/internal/notifications`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${cfg.PLATFORM_NOTIFICATION_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      event_key: "crm.external-signup.email-confirmation", notification_key: "crm.external-signup.email-confirmation",
      source: "suncoast-crm-api", severity: "info", priority: "normal", locale: "en", channels: ["email"],
      recipients: [{ type: "email", address: email, channels: ["email"] }],
      parameters: {
        confirmation_url: url,
        expires_hours: cfg.EMAIL_VERIFICATION_TTL_HOURS
      },
      subject: "Confirm your email address",
      body: `Confirm your email address by opening this link:\n\n${url}\n\nThis link expires in ${cfg.EMAIL_VERIFICATION_TTL_HOURS} hours.`,
      idempotency_key: `suncoast-crm:email-confirmation:${id}`, dedupe_key: `suncoast-crm:email-confirmation:${id}`,
      expires_at: new Date(Date.now() + cfg.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000).toISOString()
    })
  });
  if (!result.ok) throw Object.assign(new Error(`Notification service rejected confirmation email with HTTP ${result.status}`), { status: 502 });
}

export async function createEmailVerification(email: string, purpose: string, idempotencyKey: string) {
  const cfg = config();
  if (!cfg.EXTERNAL_SIGNUP_EMAIL_VERIFICATION_ENABLED) throw Object.assign(new Error("External signup email verification is disabled"), { status: 503 });
  const code = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(code).digest("hex");
  const id = randomUUID();
  return inTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO crm_email_verifications (id,tenant_id,email,purpose,idempotency_key,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,now() + make_interval(hours => $7))
       ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING *`,
      [id, cfg.CRM_TENANT_ID, email, purpose, idempotencyKey, tokenHash, cfg.EMAIL_VERIFICATION_TTL_HOURS]
    );
    if (!inserted.rowCount) {
      const existing = await client.query("SELECT * FROM crm_email_verifications WHERE tenant_id=$1 AND idempotency_key=$2", [cfg.CRM_TENANT_ID, idempotencyKey]);
      const row = existing.rows[0];
      if (!row || row.email !== email || row.purpose !== purpose) throw Object.assign(new Error("Idempotency-Key was already used for a different request"), { status: 409 });
      return { ...response(row), duplicate: true };
    }
    const url = `${cfg.EMAIL_CONFIRMATION_PUBLIC_URL}?code=${encodeURIComponent(code)}`;
    await queueConfirmationEmail(email, url, id);
    return { ...response(inserted.rows[0]), duplicate: false };
  });
}

export async function getEmailVerification(id: string) {
  const result = await pool.query(`UPDATE crm_email_verifications SET status='expired',updated_at=now()
    WHERE tenant_id=$1 AND id=$2 AND status='pending' AND expires_at <= now() RETURNING id`, [config().CRM_TENANT_ID, id]);
  void result;
  const found = await pool.query("SELECT * FROM crm_email_verifications WHERE tenant_id=$1 AND id=$2", [config().CRM_TENANT_ID, id]);
  return found.rows[0] ? response(found.rows[0]) : null;
}

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { inTransaction, pool } from "./db.js";

export type ContactEmailStatus = "pending" | "verified" | "expired";

export interface ContactEmailState {
  id: string;
  tenantId: string;
  entityId: string;
  email: string;
  purpose: string;
  status: ContactEmailStatus;
  isPrimary: boolean;
  verifiedAt: string | null;
  providerId: string | null;
  communicationsOptOut: boolean;
  communicationsOptOutAt: string | null;
}

const state = (row: Record<string, unknown>): ContactEmailState => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  entityId: String(row.entity_id),
  email: String(row.email),
  purpose: String(row.purpose),
  status: row.status as ContactEmailStatus,
  isPrimary: row.is_primary === true,
  verifiedAt: row.verified_at ? new Date(String(row.verified_at)).toISOString() : null,
  providerId: row.provider_id ? String(row.provider_id) : null,
  communicationsOptOut: row.communications_opt_out === true,
  communicationsOptOutAt: row.communications_opt_out_at ? new Date(String(row.communications_opt_out_at)).toISOString() : null
});

export async function resolveContactSubject(tenantId: string, subjectId: string, email: string): Promise<{ entityId: string; duplicate: boolean }> {
  const normalizedEmail = email.trim().toLowerCase();
  const matching = await pool.query(
    `SELECT min(entity_id::text)::uuid AS entity_id
     FROM crm_contact_emails
     WHERE tenant_id=$1 AND normalized_email=$2
     HAVING count(DISTINCT entity_id)=1`,
    [tenantId, normalizedEmail]
  );
  const proposedEntityId = matching.rows[0]?.entity_id ? String(matching.rows[0].entity_id) : randomUUID();
  const inserted = await pool.query(
    `INSERT INTO crm_contact_subjects (tenant_id,subject_id,entity_id)
     VALUES ($1,$2,$3) ON CONFLICT (tenant_id,subject_id) DO NOTHING RETURNING entity_id`,
    [tenantId, subjectId, proposedEntityId]
  );
  if (inserted.rowCount) return { entityId: String(inserted.rows[0].entity_id), duplicate: false };
  const existing = await pool.query(
    "SELECT entity_id FROM crm_contact_subjects WHERE tenant_id=$1 AND subject_id=$2",
    [tenantId, subjectId]
  );
  if (!existing.rowCount) throw new Error("Contact subject could not be resolved");
  return { entityId: String(existing.rows[0].entity_id), duplicate: true };
}

export async function upsertContactEmail(client: PoolClient, input: {
  tenantId: string;
  entityId: string;
  email: string;
  purpose: string;
  verificationId: string;
  primary?: boolean;
}): Promise<ContactEmailState> {
  const normalizedEmail = input.email.trim().toLowerCase();
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
    [input.tenantId, input.entityId]
  );
  const existingCount = await client.query(
    "SELECT count(*)::int AS count FROM crm_contact_emails WHERE tenant_id=$1 AND entity_id=$2",
    [input.tenantId, input.entityId]
  );
  const isPrimary = input.primary === true || Number(existingCount.rows[0]?.count ?? 0) === 0;
  if (isPrimary) {
    await client.query(
      "UPDATE crm_contact_emails SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND entity_id=$2 AND is_primary",
      [input.tenantId, input.entityId]
    );
  }
  let result = await client.query(
    `INSERT INTO crm_contact_emails (
       id,tenant_id,entity_id,email,normalized_email,purpose,status,is_primary,current_verification_id
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
     ON CONFLICT (tenant_id,entity_id,normalized_email) DO UPDATE SET
       email=EXCLUDED.email,
       purpose=EXCLUDED.purpose,
       is_primary=CASE WHEN EXCLUDED.is_primary THEN true ELSE crm_contact_emails.is_primary END,
       current_verification_id=CASE WHEN crm_contact_emails.status='verified' THEN crm_contact_emails.current_verification_id ELSE EXCLUDED.current_verification_id END,
       status=CASE WHEN crm_contact_emails.status='verified' THEN crm_contact_emails.status ELSE 'pending' END,
       updated_at=now()
     RETURNING *`,
    [randomUUID(), input.tenantId, input.entityId, input.email, normalizedEmail, input.purpose, isPrimary, input.verificationId]
  );
  const preference = await client.query(
    `SELECT communications_opt_out,communications_opt_out_at
     FROM crm_contact_communication_preferences
     WHERE tenant_id=$1 AND normalized_email=$2`,
    [input.tenantId, normalizedEmail]
  );
  if (preference.rowCount) {
    result = await client.query(
      `UPDATE crm_contact_emails
       SET communications_opt_out=$2,communications_opt_out_at=$3,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [result.rows[0].id, preference.rows[0].communications_opt_out, preference.rows[0].communications_opt_out_at]
    );
  }
  return state(result.rows[0]);
}

export async function getContactEmailForVerification(client: PoolClient, tenantId: string, verificationId: string): Promise<ContactEmailState | null> {
  const result = await client.query(
    `SELECT contact_email.* FROM crm_email_verifications verification
     JOIN crm_contact_emails contact_email
       ON contact_email.tenant_id=verification.tenant_id AND contact_email.id=verification.contact_email_id
     WHERE verification.tenant_id=$1 AND verification.id=$2`,
    [tenantId, verificationId]
  );
  return result.rows[0] ? state(result.rows[0]) : null;
}

export async function listContactEmails(client: PoolClient, tenantId: string, entityId: string): Promise<ContactEmailState[]> {
  const result = await client.query(
    `SELECT * FROM crm_contact_emails WHERE tenant_id=$1 AND entity_id=$2
     ORDER BY is_primary DESC,created_at,id`,
    [tenantId, entityId]
  );
  return result.rows.map(state);
}

export async function setContactEmailProjection(client: PoolClient, tenantId: string, id: string, providerId: string): Promise<void> {
  await client.query(
    "UPDATE crm_contact_emails SET provider_id=$3,projected_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenantId, id, providerId]
  );
}

export async function setContactEmailCommunicationsPreference(
  tenantId: string,
  email: string,
  communicationsOptOut: boolean
): Promise<ContactEmailState[]> {
  const normalizedEmail = email.trim().toLowerCase();
  return inTransaction(async (client) => {
    const preference = await client.query(
      `INSERT INTO crm_contact_communication_preferences (
         tenant_id,normalized_email,communications_opt_out,communications_opt_out_at
       ) VALUES ($1,$2,$3,CASE WHEN $3 THEN now() ELSE NULL END)
       ON CONFLICT (tenant_id,normalized_email) DO UPDATE SET
         communications_opt_out=EXCLUDED.communications_opt_out,
         communications_opt_out_at=CASE
           WHEN EXCLUDED.communications_opt_out THEN COALESCE(crm_contact_communication_preferences.communications_opt_out_at,now())
           ELSE NULL
         END,
         updated_at=now()
       RETURNING communications_opt_out,communications_opt_out_at`,
      [tenantId, normalizedEmail, communicationsOptOut]
    );
    const result = await client.query(
      `UPDATE crm_contact_emails
       SET communications_opt_out=$3,
           communications_opt_out_at=$4,
           updated_at=now()
       WHERE tenant_id=$1 AND normalized_email=$2
       RETURNING *`,
      [
        tenantId,
        normalizedEmail,
        preference.rows[0].communications_opt_out,
        preference.rows[0].communications_opt_out_at
      ]
    );
    return result.rows.map(state);
  });
}

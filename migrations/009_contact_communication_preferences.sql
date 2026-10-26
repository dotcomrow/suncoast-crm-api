ALTER TABLE crm_contact_emails
  ADD COLUMN IF NOT EXISTS communications_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE crm_contact_emails
  ADD COLUMN IF NOT EXISTS communications_opt_out_at timestamptz;

CREATE INDEX IF NOT EXISTS crm_contact_emails_communications_opt_out_idx
  ON crm_contact_emails (tenant_id, normalized_email, communications_opt_out)
  WHERE communications_opt_out;

CREATE TABLE IF NOT EXISTS crm_contact_communication_preferences (
  tenant_id text NOT NULL,
  normalized_email text NOT NULL,
  communications_opt_out boolean NOT NULL DEFAULT false,
  communications_opt_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, normalized_email)
);

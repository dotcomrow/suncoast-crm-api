CREATE TABLE IF NOT EXISTS crm_email_validations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  form_submission_id uuid NOT NULL UNIQUE REFERENCES crm_form_submissions(id),
  provider text NOT NULL,
  email text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','validated')),
  provider_status text,
  provider_contact_id text,
  validated_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_email_validations_lookup_idx
  ON crm_email_validations (tenant_id, lower(email), purpose, created_at DESC);

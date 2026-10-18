CREATE TABLE IF NOT EXISTS crm_email_verifications (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_email_verifications_pending_idx
  ON crm_email_verifications (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS crm_form_submissions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES crm_operations(id),
  provider text NOT NULL,
  form_name text NOT NULL,
  provider_form_id text NOT NULL,
  email text,
  fields jsonb NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  consent jsonb,
  status text NOT NULL,
  provider_response jsonb,
  error text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_form_submissions_tenant_form_created_idx
  ON crm_form_submissions (tenant_id, form_name, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_form_submissions_email_idx
  ON crm_form_submissions (tenant_id, email, created_at DESC) WHERE email IS NOT NULL;

ALTER TABLE crm_email_verifications
  ADD COLUMN IF NOT EXISTS entity_id uuid;

CREATE INDEX IF NOT EXISTS crm_email_verifications_entity_idx
  ON crm_email_verifications (tenant_id, entity_id)
  WHERE entity_id IS NOT NULL;

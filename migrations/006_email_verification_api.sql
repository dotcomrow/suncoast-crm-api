ALTER TABLE crm_email_verifications
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'external-signup';

ALTER TABLE crm_email_verifications
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE crm_email_verifications
SET idempotency_key = 'legacy:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE crm_email_verifications
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS crm_email_verifications_idempotency_idx
  ON crm_email_verifications (tenant_id, idempotency_key);

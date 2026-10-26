CREATE TABLE IF NOT EXISTS crm_contact_subjects (
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id)
);

CREATE INDEX IF NOT EXISTS crm_contact_subjects_entity_idx
  ON crm_contact_subjects (tenant_id, entity_id);

CREATE TABLE IF NOT EXISTS crm_contact_emails (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  entity_id uuid NOT NULL,
  email text NOT NULL,
  normalized_email text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired')),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  current_verification_id uuid,
  provider_id text,
  projected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_id, normalized_email)
);

CREATE INDEX IF NOT EXISTS crm_contact_emails_entity_idx
  ON crm_contact_emails (tenant_id, entity_id, is_primary DESC, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_emails_primary_idx
  ON crm_contact_emails (tenant_id, entity_id)
  WHERE is_primary;

ALTER TABLE crm_email_verifications
  ADD COLUMN IF NOT EXISTS contact_email_id uuid;

CREATE INDEX IF NOT EXISTS crm_email_verifications_contact_email_idx
  ON crm_email_verifications (tenant_id, contact_email_id)
  WHERE contact_email_id IS NOT NULL;

WITH latest AS (
  SELECT v.*,
    row_number() OVER (
      PARTITION BY v.tenant_id,v.entity_id,lower(trim(v.email))
      ORDER BY v.created_at DESC,v.id DESC
    ) AS email_rank
  FROM crm_email_verifications v
  WHERE v.entity_id IS NOT NULL
), selected AS (
  SELECT latest.*,
    row_number() OVER (
      PARTITION BY latest.tenant_id,latest.entity_id
      ORDER BY latest.created_at,latest.id
    ) AS contact_rank
  FROM latest
  WHERE latest.email_rank=1
)
INSERT INTO crm_contact_emails (
  id,tenant_id,entity_id,email,normalized_email,purpose,status,is_primary,
  verified_at,current_verification_id,created_at,updated_at
)
SELECT id,tenant_id,entity_id,email,lower(trim(email)),purpose,status,contact_rank=1,
  verified_at,id,created_at,updated_at
FROM selected
ON CONFLICT (tenant_id,entity_id,normalized_email) DO NOTHING;

UPDATE crm_email_verifications verification
SET contact_email_id=contact_email.id
FROM crm_contact_emails contact_email
WHERE verification.contact_email_id IS NULL
  AND contact_email.tenant_id=verification.tenant_id
  AND contact_email.entity_id=verification.entity_id
  AND contact_email.normalized_email=lower(trim(verification.email));

INSERT INTO crm_contact_subjects (tenant_id,subject_id,entity_id)
SELECT tenant_id,'email:' || normalized_email,min(entity_id::text)::uuid
FROM crm_contact_emails
GROUP BY tenant_id,normalized_email
HAVING count(DISTINCT entity_id)=1
ON CONFLICT (tenant_id,subject_id) DO NOTHING;

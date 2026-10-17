ALTER TABLE crm_email_validations ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE crm_email_validations ADD COLUMN IF NOT EXISTS action_plan jsonb;
ALTER TABLE crm_email_validations ADD COLUMN IF NOT EXISTS rule_set_version text;
ALTER TABLE crm_email_validations ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE crm_email_validations DROP CONSTRAINT IF EXISTS crm_email_validations_status_check;
ALTER TABLE crm_email_validations ADD CONSTRAINT crm_email_validations_status_check CHECK (status IN ('pending','validated','failed','expired'));

CREATE TABLE IF NOT EXISTS crm_email_validation_action_registry (
  tenant_id text NOT NULL, action_name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  description text, PRIMARY KEY (tenant_id,action_name)
);
CREATE TABLE IF NOT EXISTS crm_email_validation_action_defaults (
  tenant_id text NOT NULL, purpose text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('VALIDATED','FAILED','EXPIRED')),
  action_name text NOT NULL, mandatory boolean NOT NULL DEFAULT false, position integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id,purpose,outcome,action_name),
  FOREIGN KEY (tenant_id,action_name) REFERENCES crm_email_validation_action_registry(tenant_id,action_name)
);
CREATE TABLE IF NOT EXISTS crm_email_validation_user_actions (
  tenant_id text NOT NULL, user_id text NOT NULL, purpose text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('VALIDATED','FAILED','EXPIRED')),
  action_name text NOT NULL, position integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,user_id,purpose,outcome,action_name),
  FOREIGN KEY (tenant_id,action_name) REFERENCES crm_email_validation_action_registry(tenant_id,action_name)
);

INSERT INTO crm_email_validation_action_registry (tenant_id,action_name,description) VALUES
  ('suncoast','crm.email-validation.record-outcome','Record the terminal validation outcome'),
  ('suncoast','subscription.activate','Activate the requested subscription'),
  ('suncoast','subscription.reject','Reject the requested subscription')
ON CONFLICT DO NOTHING;
INSERT INTO crm_email_validation_action_defaults (tenant_id,purpose,outcome,action_name,mandatory,position) VALUES
  ('suncoast','*','VALIDATED','crm.email-validation.record-outcome',true,0),
  ('suncoast','*','FAILED','crm.email-validation.record-outcome',true,0),
  ('suncoast','*','EXPIRED','crm.email-validation.record-outcome',true,0),
  ('suncoast','*','VALIDATED','subscription.activate',false,10),
  ('suncoast','*','FAILED','subscription.reject',false,10),
  ('suncoast','*','EXPIRED','subscription.reject',false,10)
ON CONFLICT DO NOTHING;

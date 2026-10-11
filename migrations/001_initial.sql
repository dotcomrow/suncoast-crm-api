CREATE TABLE IF NOT EXISTS crm_entities (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, entity_type text NOT NULL,
  provider text NOT NULL, provider_id text, properties jsonb NOT NULL DEFAULT '{}', associations jsonb NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (tenant_id, provider, entity_type, provider_id)
);
CREATE INDEX IF NOT EXISTS crm_entities_tenant_type_id_idx ON crm_entities (tenant_id, entity_type, id);
CREATE TABLE IF NOT EXISTS crm_operations (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, provider text NOT NULL, action text NOT NULL, entity_type text, entity_id uuid,
  status text NOT NULL, idempotency_key text NOT NULL, correlation_id text NOT NULL, request jsonb NOT NULL DEFAULT '{}', result jsonb,
  error text, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS crm_operations_entity_idx ON crm_operations (tenant_id, entity_type, entity_id, created_at DESC);
CREATE TABLE IF NOT EXISTS crm_outbox (
  id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, topic text NOT NULL, message_key text NOT NULL, payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_outbox_pending_idx ON crm_outbox (available_at, created_at) WHERE published_at IS NULL;

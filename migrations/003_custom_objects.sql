CREATE TABLE IF NOT EXISTS crm_custom_object_definitions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  singular_label text NOT NULL,
  plural_label text NOT NULL,
  primary_display_property text NOT NULL,
  fields jsonb NOT NULL,
  provider text NOT NULL,
  storage_mode text NOT NULL DEFAULT 'local' CHECK (storage_mode IN ('local', 'contact_properties', 'provider_custom_object')),
  cardinality text NOT NULL DEFAULT 'many_per_contact' CHECK (cardinality IN ('one_per_contact', 'many_per_contact')),
  provider_object_type text,
  provider_schema jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS crm_custom_object_records (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  definition_id uuid NOT NULL REFERENCES crm_custom_object_definitions(id),
  contact_id uuid NOT NULL REFERENCES crm_entities(id),
  singleton_contact_id uuid,
  provider_id text,
  properties jsonb NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (definition_id, provider_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_custom_object_records_singleton_idx
  ON crm_custom_object_records (definition_id, singleton_contact_id)
  WHERE singleton_contact_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS crm_custom_object_records_definition_idx
  ON crm_custom_object_records (tenant_id, definition_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_custom_object_records_contact_idx
  ON crm_custom_object_records (tenant_id, contact_id, definition_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_custom_object_definition_migrations (
  object_name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_name, version),
  UNIQUE (filename)
);


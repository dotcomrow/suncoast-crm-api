CREATE TABLE IF NOT EXISTS crm_notification_outbox (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES crm_operations(id),
  notification_kind text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, notification_kind)
);
CREATE INDEX IF NOT EXISTS crm_notification_outbox_pending_idx
  ON crm_notification_outbox (available_at, created_at) WHERE delivered_at IS NULL;

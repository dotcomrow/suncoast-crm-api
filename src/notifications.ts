import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { inTransaction } from "./db.js";
import type { CrmCommand } from "./types.js";

interface NotificationRow { id: string; payload: Record<string, unknown>; attempts: number }
export type FailureNotificationKind = "retrying" | "failed";

export function hubSpotFailureNotification(command: CrmCommand, error: unknown, attempts: number, kind: FailureNotificationKind): Record<string, unknown> {
  const cfg = config();
  const failure = String(error).slice(0, 4000);
  const terminal = kind === "failed";
  return {
    event_key: `crm.hubspot.operation.${kind}`,
    notification_key: `crm.hubspot.operation.${kind}`,
    source: "suncoast-crm-api",
    severity: terminal ? "error" : "warning",
    priority: "high",
    locale: "en",
    channels: ["email"],
    recipients: [{ type: "email", address: cfg.HUBSPOT_FAILURE_NOTIFICATION_EMAIL, channels: ["email"] }],
    subject: terminal
      ? `HubSpot CRM operation failed permanently: ${command.action} ${command.entityType ?? "entity"}`
      : `HubSpot CRM operation is retrying: ${command.action} ${command.entityType ?? "entity"}`,
    body: terminal
      ? `The Suncoast CRM worker could not complete a HubSpot operation after ${attempts} attempts and moved it to the DLQ.\n\nOperation: ${command.operationId}\nAction: ${command.action}\nEntity type: ${command.entityType ?? "n/a"}\nEntity ID: ${command.entityId ?? "n/a"}\nCorrelation ID: ${command.correlationId}\nFailure: ${failure}`
      : `The first HubSpot attempt failed. The operation remains durable and will be retried with increasing delays.\n\nOperation: ${command.operationId}\nAction: ${command.action}\nEntity type: ${command.entityType ?? "n/a"}\nEntity ID: ${command.entityId ?? "n/a"}\nCorrelation ID: ${command.correlationId}\nFailure: ${failure}`,
    parameters: { operation_id: command.operationId, action: command.action, entity_type: command.entityType, entity_id: command.entityId, attempts, status: kind, failure },
    data: { operation_id: command.operationId, correlation_id: command.correlationId },
    metadata: { provider: command.provider, tenant_id: command.tenantId },
    idempotency_key: `suncoast-crm:hubspot-${kind}:${command.operationId}`,
    dedupe_key: `suncoast-crm:hubspot-${kind}:${command.operationId}`,
    correlation_id: command.correlationId
  };
}

export async function enqueueFailureNotification(client: import("pg").PoolClient, command: CrmCommand, error: unknown, attempts: number, kind: FailureNotificationKind): Promise<void> {
  await client.query(
    `INSERT INTO crm_notification_outbox (id, operation_id, notification_kind, payload)
     VALUES ($1,$2,$3,$4) ON CONFLICT (operation_id, notification_kind) DO NOTHING`,
    [randomUUID(), command.operationId, kind, hubSpotFailureNotification(command, error, attempts, kind)]
  );
}

async function dispatchNotification(row: NotificationRow): Promise<void> {
  const cfg = config();
  if (!cfg.PLATFORM_NOTIFICATION_TOKEN) throw new Error("PLATFORM_NOTIFICATION_TOKEN is not configured");
  const response = await fetch(`${cfg.PLATFORM_NOTIFICATION_SERVICE_URL.replace(/\/$/, "")}/internal/notifications`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.PLATFORM_NOTIFICATION_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(row.payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`notification service HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
}

export async function dispatchOneNotification(): Promise<boolean> {
  return inTransaction(async (client) => {
    const selected = await client.query<NotificationRow>(
      `SELECT id,payload,attempts FROM crm_notification_outbox
       WHERE delivered_at IS NULL AND available_at <= now()
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    const row = selected.rows[0];
    if (!row) return false;
    try {
      await dispatchNotification(row);
      await client.query("UPDATE crm_notification_outbox SET delivered_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1", [row.id]);
    } catch (error) {
      await client.query(
        `UPDATE crm_notification_outbox SET attempts=attempts+1,last_error=$2,
         available_at=now() + make_interval(secs => LEAST(21600, 60 * power(2, LEAST(attempts, 8)))::int)
         WHERE id=$1`, [row.id, String(error)]
      );
      console.error("failure notification delivery failed", error);
    }
    return true;
  });
}

export async function runNotificationOutbox(stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    try {
      while (!stopped() && await dispatchOneNotification()) { /* drain ready notifications */ }
    } catch (error) {
      console.error("notification outbox dispatch failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, config().NOTIFICATION_OUTBOX_POLL_MS));
  }
}

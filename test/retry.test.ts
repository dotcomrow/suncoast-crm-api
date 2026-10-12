import assert from "node:assert/strict";
import test from "node:test";
import type { CrmCommand } from "../src/types.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";

test("retry schedule uses increasing durable delays and caps at 24 hours", async () => {
  const { retryScheduleForAttempt, retrySchedules } = await import("../src/retry.js");
  assert.deepEqual(retrySchedules().map(({ delaySeconds }) => delaySeconds), [60, 300, 1800, 7200, 21600, 86400]);
  assert.equal(retryScheduleForAttempt(1).topic, "crm.commands.retry.1m.v1");
  assert.equal(retryScheduleForAttempt(6).topic, "crm.commands.retry.24h.v1");
  assert.equal(retryScheduleForAttempt(99).topic, "crm.commands.retry.24h.v1");
});

test("HubSpot failure notifications select the correct templates and remain idempotent", async () => {
  const { hubSpotFailureNotification } = await import("../src/notifications.js");
  const command: CrmCommand = {
    schemaVersion: 1,
    id: "command-1",
    operationId: "operation-1",
    tenantId: "suncoast",
    provider: "hubspot",
    action: "create",
    entityType: "contacts",
    entityId: "entity-1",
    payload: {},
    correlationId: "correlation-1",
    requestedAt: new Date(0).toISOString()
  };
  const payload = hubSpotFailureNotification(command, new Error("HubSpot unavailable"), 30, "failed");
  assert.deepEqual(payload.channels, ["email"]);
  assert.equal(payload.notification_key, "crm.hubspot.operation.failed");
  assert.deepEqual(payload.recipients, [{ type: "email", address: "administrator@suncoast.systems", channels: ["email"] }]);
  assert.equal(payload.idempotency_key, "suncoast-crm:hubspot-failed:operation-1");
  assert.match(String(payload.body), /HubSpot unavailable/);

  const retryingPayload = hubSpotFailureNotification(command, new Error("HubSpot unavailable"), 1, "retrying");
  assert.equal(retryingPayload.notification_key, "crm.hubspot.operation.retrying");
  assert.equal(retryingPayload.idempotency_key, "suncoast-crm:hubspot-retrying:operation-1");
  assert.equal(retryingPayload.severity, "warning");
});

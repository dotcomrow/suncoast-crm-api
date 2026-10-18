import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";

test("retry schedule uses increasing durable delays and caps at 24 hours", async () => {
  const { retryScheduleForAttempt, retrySchedules } = await import("../src/retry.js");
  assert.deepEqual(retrySchedules().map(({ delaySeconds }) => delaySeconds), [60, 300, 1800, 7200, 21600, 86400]);
  assert.equal(retryScheduleForAttempt(1).topic, "crm.commands.retry.1m.v1");
  assert.equal(retryScheduleForAttempt(6).topic, "crm.commands.retry.24h.v1");
  assert.equal(retryScheduleForAttempt(99).topic, "crm.commands.retry.24h.v1");
});

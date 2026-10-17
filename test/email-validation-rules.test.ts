import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";

test("parses an email-validation decision from KIE execution results", () => {
  return import("../src/email-validation-rules.js").then(({ parseKieDecision }) => {
  const decision = parseKieDecision({ result: { "execution-results": { results: [{ key: "decisions", value: [
    { "com.dotcomrow.rules.emailvalidation.EmailValidationRequest": { validationId: "v1" } },
    { "com.dotcomrow.rules.emailvalidation.EmailValidationDecision": { accepted: true, reason: "actions_resolved", ruleSetVersion: "email-validation-1.0.0", actions: ["subscription.activate"], rejectedActions: [] } }
  ] }] } } });
  assert.deepEqual(decision.actions, ["subscription.activate"]);
  assert.equal(decision.accepted, true);
  });
});

test("rejects a KIE response without the expected decision fact", async () => {
  const { parseKieDecision } = await import("../src/email-validation-rules.js");
  assert.throws(() => parseKieDecision({ result: { "execution-results": { results: [] } } }), /did not contain/);
});

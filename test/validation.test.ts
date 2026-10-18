import assert from "node:assert/strict";
import test from "node:test";
import { externalContactSignupBody } from "../src/validation.js";

test("external contact signups require a valid email", () => {
  assert.equal(externalContactSignupBody.safeParse({ properties: { firstname: "Pat" } }).success, false);
  assert.equal(externalContactSignupBody.safeParse({ properties: { email: "not-an-email" } }).success, false);
});

test("external contact signups accept the stable and native EspoCRM email names", () => {
  const stable = externalContactSignupBody.parse({ properties: { email: "USER@Example.com" } });
  const native = externalContactSignupBody.parse({ properties: { emailAddress: "user@example.com" } });
  assert.equal(stable.purpose, "external-signup");
  assert.equal(native.purpose, "external-signup");
});

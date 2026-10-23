import assert from "node:assert/strict";
import test from "node:test";
import { externalContactOperationIdempotencyKey, externalContactProperties, externalContactSignupBody } from "../src/validation.js";

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

test("notification contact creation is idempotent per normalized email", () => {
  const first = externalContactOperationIdempotencyKey(" User@Example.com ", "notifications", "request-one");
  const replay = externalContactOperationIdempotencyKey("user@example.com", "notifications", "request-two");
  assert.equal(first, replay);
  assert.match(first, /^notification-contact:[a-f0-9]{32}$/);
  assert.equal(externalContactOperationIdempotencyKey("user@example.com", "external-signup", "request-three"), "request-three");
});

test("external contacts receive editable placeholder names when no name is supplied", () => {
  assert.deepEqual(externalContactProperties({ email: "user@example.com" }), {
    email: "user@example.com",
    firstname: "Notification",
    lastname: "Subscriber"
  });
  assert.deepEqual(externalContactProperties({ email: "user@example.com", firstName: "Pat", lastName: "Lee" }), {
    email: "user@example.com",
    firstName: "Pat",
    lastName: "Lee"
  });
});

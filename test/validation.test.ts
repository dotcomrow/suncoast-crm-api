import assert from "node:assert/strict";
import test from "node:test";
import { externalContactOperationIdempotencyKey, externalContactProperties, externalContactSignupBody, externalContactSubjectId } from "../src/validation.js";

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

test("notification contact creation is idempotent per stable subject", () => {
  const subject = "directus-user:user-1";
  const first = externalContactOperationIdempotencyKey(subject, "notifications", "request-one");
  const replay = externalContactOperationIdempotencyKey(subject, "notifications", "request-two");
  assert.equal(first, replay);
  assert.match(first, /^notification-contact:[a-f0-9]{32}$/);
  assert.equal(externalContactOperationIdempotencyKey(subject, "external-signup", "request-three"), "request-three");
  assert.equal(externalContactSubjectId(undefined, " User@Example.com "), "email:user@example.com");
  assert.equal(externalContactSubjectId(subject, "other@example.com"), subject);
});

test("external contacts receive stable unique placeholder names when no name is supplied", () => {
  assert.deepEqual(externalContactProperties({ email: "user@example.com" }, "email:user@example.com"), {
    firstname: "Notification",
    lastname: "user"
  });
  assert.deepEqual(externalContactProperties({ email: "user@example.com", firstname: "Notification", lastname: "Subscriber" }, "email:user@example.com"), {
    firstname: "Notification",
    lastname: "user"
  });
  assert.deepEqual(externalContactProperties({ email: "other@example.com" }, "directus-user:user-1"), {
    firstname: "Notification",
    lastname: "Subscriber-c64a7289bd"
  });
  assert.deepEqual(externalContactProperties({ email: "user@example.com", firstName: "Pat", lastName: "Lee" }, "email:user@example.com"), {
    firstName: "Pat",
    lastName: "Lee"
  });
});

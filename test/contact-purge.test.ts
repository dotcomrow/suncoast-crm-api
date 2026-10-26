import assert from "node:assert/strict";
import test from "node:test";
import { contactPurgeAuthorized } from "../src/internal-auth.js";

test("contact purge authorization requires an exact bearer token", () => {
  const token = "a".repeat(64);
  assert.equal(contactPurgeAuthorized(token, `Bearer ${token}`), true);
  assert.equal(contactPurgeAuthorized(token, `bearer ${token}`), true);
  assert.equal(contactPurgeAuthorized(token, `Bearer ${"b".repeat(64)}`), false);
  assert.equal(contactPurgeAuthorized(token, "Bearer short"), false);
  assert.equal(contactPurgeAuthorized(undefined, `Bearer ${token}`), false);
  assert.equal(contactPurgeAuthorized(token, undefined), false);
});

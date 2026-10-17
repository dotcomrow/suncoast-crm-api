import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";

test("generated OpenAPI exposes the stable CRM and operation paths", async () => {
  const { openApiSpec } = await import("../src/openapi.js");
  const spec = openApiSpec();
  assert.equal(spec.openapi, "3.0.3");
  assert.ok(spec.paths["/v1/{entityType}"]);
  assert.ok(spec.paths["/v1/{entityType}/{entityId}"]);
  assert.ok(spec.paths["/v1/operations/{operationId}"]);
  assert.ok(spec.paths["/v1/email-validations"]);
  assert.ok(spec.paths["/v1/email-validations/{validationId}"]);
  assert.ok(spec.paths["/v1/email-validations/{validationId}/outcome"]);
  assert.ok(spec.paths["/v1/email-validation-action-config/users/{userId}"]);
  assert.ok(spec.paths["/v1/custom-objects"]);
  assert.ok(spec.paths["/v1/custom-objects/{objectName}/records"]);
  assert.ok(spec.paths["/v1/custom-objects/{objectName}/records/{recordId}"]);
  assert.ok(spec.paths["/v1/forms/{formName}/submissions"]);
  assert.ok(spec.paths["/v1/form-submissions/{submissionId}"]);
  assert.equal("post" in spec.paths["/v1/custom-objects"], false);
  assert.equal("patch" in spec.paths["/v1/custom-objects/{objectName}"], false);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.deepEqual(spec.paths["/healthz"].get.security, []);
  const operationIds = Object.values(spec.paths).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
  assert.equal(new Set(operationIds).size, operationIds.length);
  const parameters = Object.values(spec.paths).flatMap((path) => Object.values(path).flatMap((operation) => operation.parameters ?? []));
  assert.equal(parameters.some((parameter) => parameter.name === "X-Tenant-ID"), false);
});

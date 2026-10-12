import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";

test("custom object definitions require a declared primary display field", async () => {
  const { customObjectDefinitionBody } = await import("../src/custom-objects.js");
  const result = customObjectDefinitionBody.safeParse({
    name: "component_preferences",
    singular_label: "Component preference",
    plural_label: "Component preferences",
    primary_display_property: "email",
    fields: [{ name: "status", label: "Status", type: "string" }]
  });
  assert.equal(result.success, false);
});

test("custom properties are validated from a registered definition", async () => {
  const { customObjectDefinitionBody, validateCustomProperties } = await import("../src/custom-objects.js");
  const input = customObjectDefinitionBody.parse({
    name: "component_preferences",
    singular_label: "Component preference",
    plural_label: "Component preferences",
    primary_display_property: "email",
    fields: [
      { name: "email", label: "Email", type: "string", required: true },
      { name: "status", label: "Status", type: "enumeration", options: [{ label: "Subscribed", value: "subscribed" }] }
    ]
  });
  assert.equal(input.storage_mode, "local");
  assert.equal(input.cardinality, "many_per_contact");
  const definition = { ...input, id: "definition-1", provider: "hubspot", provider_object_type: "2-123", provider_schema: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  assert.doesNotThrow(() => validateCustomProperties(definition, { email: "person@example.com", status: "subscribed" }));
  assert.throws(() => validateCustomProperties(definition, { status: "invalid" }), /email.*required/);
  assert.throws(() => validateCustomProperties(definition, { email: "person@example.com", unexpected: true }), /Unknown property/);
});

test("contact-property projections require one record per contact", async () => {
  const { customObjectDefinitionBody } = await import("../src/custom-objects.js");
  const result = customObjectDefinitionBody.safeParse({
    name: "component_preferences",
    singular_label: "Component preference",
    plural_label: "Component preferences",
    primary_display_property: "email",
    storage_mode: "contact_properties",
    fields: [{ name: "email", label: "Email", type: "string" }]
  });
  assert.equal(result.success, false);
});

test("custom record updates cannot be empty", async () => {
  const { customRecordUpdateBody } = await import("../src/custom-objects.js");
  assert.equal(customRecordUpdateBody.safeParse({ properties: {} }).success, false);
});

test("repository-managed definition loader accepts an empty definitions directory", async () => {
  const { loadDefinitionMigrationFiles } = await import("../src/definition-migrations.js");
  const files = await loadDefinitionMigrationFiles();
  assert.deepEqual(files, []);
});

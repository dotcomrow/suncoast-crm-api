import assert from "node:assert/strict";
import test from "node:test";
import { ensureHubSpotIdempotencyProperties, HubSpotProvider } from "../src/providers/hubspot.js";
import type { CrmEntity } from "../src/types.js";

const entity: CrmEntity = { id: "a", type: "contacts", provider: "hubspot", providerId: null, properties: { email: "test@example.com" }, associations: {}, version: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

test("HubSpot adapter maps a stable contact to the v3 objects API", async (t) => {
  let request: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ results: [{ id: "123", properties: { email: "test@example.com" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").create("contacts", entity);
  assert.equal(request?.url, "https://api.hubapi.test/crm/v3/objects/contacts/batch/upsert");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { inputs: [{ id: "a", idProperty: "suncoast_crm_id", objectWriteTraceId: "a", properties: { email: "test@example.com", suncoast_crm_id: "a" } }] });
  assert.equal(result.providerId, "123");
});

test("HubSpot adapter marks throttling as retryable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("slow down", { status: 429 }));
  await assert.rejects(() => new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").create("contacts", entity), (error: unknown) => {
    return error instanceof Error && "retryable" in error && error.retryable === true;
  });
});

test("HubSpot adapter submits configured forms through the secure Forms API", async (t) => {
  let request: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ inlineMessage: "Thanks" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const provider = new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id", "https://api.hsforms.test");
  const result = await provider.submitForm("12345", "12345678-1234-1234-1234-123456789abc", {
    fields: { email: "person@example.com", signup_source: "footer" },
    context: { pageUri: "https://suncoast.systems/", pageName: "Home" },
    consent: { consentToProcess: true, text: "Store my information.", communications: [{ value: true, subscriptionTypeId: 7, text: "Send newsletter email." }] }
  });
  assert.equal(request?.url, "https://api.hsforms.test/submissions/v3/integration/secure/submit/12345/12345678-1234-1234-1234-123456789abc");
  assert.equal(request?.init?.method, "POST");
  assert.equal((request?.init?.headers as Record<string, string>).authorization, "Bearer secret");
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body.fields, [{ name: "email", value: "person@example.com" }, { name: "signup_source", value: "footer" }]);
  assert.deepEqual(body.legalConsentOptions.consent.communications, [{ value: true, subscriptionTypeId: 7, text: "Send newsletter email." }]);
  assert.equal(result.inlineMessage, "Thanks");
});

test("HubSpot adapter uses the built-in unique ID for notes", async (t) => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: [{ id: "456", properties: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").create("activities", { ...entity, type: "activities" });
  assert.deepEqual(body, { inputs: [{ id: "a", idProperty: "hs_unique_id", objectWriteTraceId: "a", properties: { email: "test@example.com", hs_unique_id: "a" } }] });
});

test("HubSpot adapter creates a contact-associated custom object and retains its object type ID", async (t) => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.method === "GET") return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ objectTypeId: "2-123", name: "component_preferences" }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const result = await new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").defineCustomObject({
    name: "component_preferences",
    singular_label: "Component preference",
    plural_label: "Component preferences",
    primary_display_property: "email",
    fields: [{ name: "email", label: "Email", type: "string", required: true, unique: false, options: [] }]
  });
  assert.equal(result.objectType, "2-123");
  const create = requests.find((request) => request.method === "POST");
  assert.deepEqual(create?.body?.associatedObjects, ["CONTACT"]);
  assert.equal((create?.body?.properties as Array<{ name: string }>).some((property) => property.name === "suncoast_contact_id"), true);
});

test("HubSpot custom records use the stored object type and associate to the provider contact", async (t) => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.url.includes("/batch/upsert")) return new Response(JSON.stringify({ results: [{ id: "record-123", properties: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ status: "COMPLETE" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const definition = {
    id: "definition-1", name: "component_preferences", singular_label: "Component preference", plural_label: "Component preferences",
    primary_display_property: "email", fields: [{ name: "email", label: "Email", type: "string" as const, required: true, unique: false, options: [] }],
    provider: "hubspot", provider_object_type: "2-123", provider_schema: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString()
  };
  await new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").createCustomRecord(definition, "record-local", "contact-local", "contact-456", { email: "person@example.com" });
  assert.equal(requests[0]?.url, "https://api.hubapi.test/crm/v3/objects/2-123/batch/upsert");
  assert.equal(requests[1]?.url, "https://api.hubapi.test/crm/v4/objects/2-123/record-123/associations/default/contacts/contact-456");
  assert.equal(requests[1]?.method, "PUT");
});

test("HubSpot contact projection creates namespaced properties without custom objects", async (t) => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ id: "contact-456", properties: {} }), { status: request.method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
  });
  const provider = new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id");
  const input = {
    name: "component_preferences", singular_label: "Component preference", plural_label: "Component preferences", primary_display_property: "email",
    storage_mode: "contact_properties" as const, cardinality: "one_per_contact" as const,
    fields: [{ name: "status", label: "Status", type: "string" as const, required: false, unique: false, options: [] }]
  };
  await provider.defineContactPropertyProjection(input);
  assert.equal(requests.some((request) => request.url.endsWith("/crm/v3/properties/contacts") && request.body?.name === "suncoast_component_preferences_status"), true);
  await provider.writeContactPropertyProjection({ ...input, id: "definition-1", provider: "hubspot", provider_object_type: "contacts", provider_schema: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }, "contact-456", { status: "subscribed" });
  const update = requests.at(-1);
  assert.equal(update?.url, "https://api.hubapi.test/crm/v3/objects/contacts/contact-456");
  assert.deepEqual(update?.body, { properties: { suncoast_component_preferences_status: "subscribed" } });
});

test("HubSpot setup creates missing properties in existing standard groups", async (t) => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.url.endsWith("/notes/hs_unique_id")) {
      return new Response(JSON.stringify({ type: "string", hasUniqueValue: true, modificationMetadata: { readOnlyValue: false } }), { status: 200 });
    }
    if (request.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({}), { status: 201 });
  });
  await ensureHubSpotIdempotencyProperties("secret", "https://api.hubapi.test", "suncoast_crm_id");
  assert.equal(requests.some((request) => request.url.endsWith("/groups")), false);
  assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.body?.groupName), ["contactinformation", "companyinformation", "dealinformation"]);
});

test("HubSpot setup validates existing properties without rewriting them", async (t) => {
  const requests: Array<{ method: string }> = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push({ method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ type: "string", hasUniqueValue: true, modificationMetadata: { readOnlyValue: false } }), { status: 200 });
  });
  await ensureHubSpotIdempotencyProperties("secret", "https://api.hubapi.test", "suncoast_crm_id");
  assert.equal(requests.every((request) => request.method === "GET"), true);
});

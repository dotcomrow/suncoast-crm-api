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

test("HubSpot adapter uses the built-in unique ID for notes", async (t) => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: [{ id: "456", properties: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await new HubSpotProvider("secret", "https://api.hubapi.test", "suncoast_crm_id").create("activities", { ...entity, type: "activities" });
  assert.deepEqual(body, { inputs: [{ id: "a", idProperty: "hs_unique_id", objectWriteTraceId: "a", properties: { email: "test@example.com", hs_unique_id: "a" } }] });
});

test("HubSpot setup reuses standard groups and does not create property groups", async (t) => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.url.endsWith("/notes/hs_unique_id")) {
      return new Response(JSON.stringify({ hasUniqueValue: true, modificationMetadata: { readOnlyValue: false } }), { status: 200 });
    }
    if (request.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({}), { status: 201 });
  });
  await ensureHubSpotIdempotencyProperties("secret", "https://api.hubapi.test", "suncoast_crm_id");
  assert.equal(requests.some((request) => request.url.endsWith("/groups")), false);
  assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.body?.groupName), ["contactinformation", "companyinformation", "dealinformation"]);
});

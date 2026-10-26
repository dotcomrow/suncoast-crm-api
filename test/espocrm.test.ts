import assert from "node:assert/strict";
import test from "node:test";
import { EspoCrmProvider } from "../src/providers/espocrm.js";
import type { CrmEntity } from "../src/types.js";

const entity: CrmEntity = {
  id: "local-1", type: "contacts", provider: "espocrm", providerId: null,
  properties: { firstname: "Pat", lastname: "Lee", email: "pat@example.com" }, associations: {}, version: 1,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
};

test("EspoCRM adapter searches by the replay key before creating a contact", async (t) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), init });
    if (!init?.method) return new Response(JSON.stringify({ list: [], total: 0 }), { status: 200 });
    return new Response(JSON.stringify({ id: "espo-1", firstName: "Pat", lastName: "Lee" }), { status: 201 });
  });
  const result = await new EspoCrmProvider("key", "https://crm.example.test", "cSuncoastCrmId").create("contacts", entity);
  const search = new URL(requests[0].url);
  assert.equal(search.pathname, "/api/v1/Contact");
  assert.equal(search.searchParams.has("where"), false);
  assert.equal(search.searchParams.get("where[0][type]"), "equals");
  assert.equal(search.searchParams.get("where[0][attribute]"), "cSuncoastCrmId");
  assert.equal(search.searchParams.get("where[0][value]"), "local-1");
  assert.equal(requests[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { firstName: "Pat", lastName: "Lee", emailAddress: "pat@example.com", cSuncoastCrmId: "local-1" });
  assert.equal((requests[1].init?.headers as Record<string, string>)["X-Api-Key"], "key");
  assert.equal(result.providerId, "espo-1");
});

test("EspoCRM adapter updates the existing record on a replay", async (t) => {
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (!init?.method) return new Response(JSON.stringify({ list: [{ id: "espo-existing" }], total: 1 }), { status: 200 });
    return new Response(JSON.stringify({ id: "espo-existing", firstName: "Pat" }), { status: 200 });
  });
  const result = await new EspoCrmProvider("key", "https://crm.example.test/", "cSuncoastCrmId").create("contacts", entity);
  assert.deepEqual(methods, ["GET", "PUT"]);
  assert.equal(result.providerId, "espo-existing");
});

test("EspoCRM adapter maps provider-neutral email confirmation fields", async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "espo-1", ...body }), { status: 200 });
  });
  await new EspoCrmProvider("key", "https://crm.example.test", "cSuncoastCrmId").update("contacts", "espo-1", {
    ...entity,
    providerId: "espo-1",
    properties: { ...entity.properties, email_verified: true, email_verified_at: "2026-10-18T15:31:26.758Z" }
  });
  assert.equal(body.cEmailVerified, true);
  assert.equal(body.cEmailVerifiedAt, "2026-10-18 15:31:26");
  assert.equal(body.email_verified, undefined);
});

test("EspoCRM adapter maps offset pagination to the stable cursor", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ list: [{ id: "1" }, { id: "2" }], total: 5 }), { status: 200 }));
  const page = await new EspoCrmProvider("key", "https://crm.example.test", "cSuncoastCrmId").list("companies", { cursor: "2", limit: 2 });
  assert.deepEqual(page.items.map((item) => item.providerId), ["1", "2"]);
  assert.equal(page.nextCursor, "4");
});

test("EspoCRM adapter classifies throttling as retryable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("slow down", { status: 429 }));
  await assert.rejects(
    () => new EspoCrmProvider("key", "https://crm.example.test", "cSuncoastCrmId").get("contacts", "1"),
    (error: unknown) => error instanceof Error && "retryable" in error && error.retryable === true
  );
});

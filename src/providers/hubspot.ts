import type { CrmEntity, EntityType, ProviderWriteResult } from "../types.js";
import type { CrmProvider, ListOptions } from "./provider.js";
import { ProviderError } from "./provider.js";

interface HubSpotObject { id: string; properties?: Record<string, unknown>; }
interface HubSpotBatchResult { results?: HubSpotObject[]; errors?: Array<{ message?: string }> }
const objectNames: Record<EntityType, string> = {
  contacts: "contacts", companies: "companies", deals: "deals", activities: "notes"
};
const builtInIdempotencyProperties: Partial<Record<EntityType, string>> = { activities: "hs_unique_id" };

export class HubSpotProvider implements CrmProvider {
  readonly name = "hubspot";
  constructor(private readonly token: string, private readonly baseUrl: string, private readonly idempotencyProperty: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init.headers }
    });
    if (response.status === 404) throw new ProviderError("HubSpot object not found", false, 404);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ProviderError(`HubSpot ${response.status}: ${detail}`, retryable, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private result(item: HubSpotObject): ProviderWriteResult {
    return { providerId: item.id, properties: item.properties ?? {}, raw: item as unknown as Record<string, unknown> };
  }

  private ensureSupported(entity: CrmEntity): void {
    if (Object.keys(entity.associations).length) {
      throw new ProviderError("HubSpot associations require an explicit association type mapping and are not supported by the v1 adapter", false, 400);
    }
  }

  async create(type: EntityType, entity: CrmEntity): Promise<ProviderWriteResult> {
    this.ensureSupported(entity);
    const idempotencyProperty = builtInIdempotencyProperties[type] ?? this.idempotencyProperty;
    const response = await this.request<HubSpotBatchResult>(`/crm/v3/objects/${objectNames[type]}/batch/upsert`, {
      method: "POST",
      body: JSON.stringify({ inputs: [{
        id: entity.id,
        idProperty: idempotencyProperty,
        objectWriteTraceId: entity.id,
        properties: { ...entity.properties, [idempotencyProperty]: entity.id }
      }] })
    });
    const item = response.results?.[0];
    if (!item) throw new ProviderError(response.errors?.[0]?.message ?? "HubSpot upsert returned no object", true);
    return this.result(item);
  }
  async update(type: EntityType, providerId: string, entity: CrmEntity): Promise<ProviderWriteResult> {
    this.ensureSupported(entity);
    const item = await this.request<HubSpotObject>(`/crm/v3/objects/${objectNames[type]}/${encodeURIComponent(providerId)}`, {
      method: "PATCH", body: JSON.stringify({ properties: entity.properties })
    });
    return this.result(item);
  }
  async delete(type: EntityType, providerId: string): Promise<void> {
    try { await this.request<void>(`/crm/v3/objects/${objectNames[type]}/${encodeURIComponent(providerId)}`, { method: "DELETE" }); }
    catch (error) { if (!(error instanceof ProviderError && error.status === 404)) throw error; }
  }
  async get(type: EntityType, providerId: string): Promise<ProviderWriteResult | null> {
    try { return this.result(await this.request<HubSpotObject>(`/crm/v3/objects/${objectNames[type]}/${encodeURIComponent(providerId)}`)); }
    catch (error) { if (error instanceof ProviderError && error.status === 404) return null; throw error; }
  }
  async list(type: EntityType, options: ListOptions): Promise<{ items: ProviderWriteResult[]; nextCursor?: string }> {
    const query = new URLSearchParams({ limit: String(options.limit) });
    if (options.cursor) query.set("after", options.cursor);
    const page = await this.request<{ results: HubSpotObject[]; paging?: { next?: { after?: string } } }>(`/crm/v3/objects/${objectNames[type]}?${query}`);
    return { items: page.results.map((item) => this.result(item)), nextCursor: page.paging?.next?.after };
  }
}

export async function ensureHubSpotIdempotencyProperties(token: string, baseUrl: string, propertyName: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const [entityType, objectType] of Object.entries(objectNames) as Array<[EntityType, string]>) {
    const builtInProperty = builtInIdempotencyProperties[entityType];
    if (builtInProperty) {
      const existing = await fetch(`${baseUrl}/crm/v3/properties/${objectType}/${builtInProperty}`, { headers });
      if (!existing.ok) throw new Error(`Unable to verify HubSpot ${objectType} built-in idempotency property ${builtInProperty}: ${existing.status} ${(await existing.text()).slice(0, 500)}`);
      const metadata = await existing.json() as { hasUniqueValue?: boolean; modificationMetadata?: { readOnlyValue?: boolean } };
      if (!metadata.hasUniqueValue || metadata.modificationMetadata?.readOnlyValue) {
        throw new Error(`HubSpot ${objectType} property ${builtInProperty} is not writable and unique`);
      }
      continue;
    }
    const existing = await fetch(`${baseUrl}/crm/v3/properties/${objectType}/${propertyName}`, { headers });
    if (existing.status === 404) {
      throw new Error(`HubSpot ${objectType} is missing required unique text property '${propertyName}'. Create it manually in HubSpot before deploying.`);
    }
    if (!existing.ok) throw new Error(`Unable to inspect HubSpot ${objectType} property: ${existing.status} ${(await existing.text()).slice(0, 500)}`);
    const metadata = await existing.json() as { type?: string; hasUniqueValue?: boolean; modificationMetadata?: { readOnlyValue?: boolean } };
    if (metadata.type !== "string" || !metadata.hasUniqueValue || metadata.modificationMetadata?.readOnlyValue) {
      throw new Error(`HubSpot ${objectType} property '${propertyName}' must be a writable, unique single-line text property`);
    }
  }
}

import type { CrmEntity, EntityType, ProviderWriteResult } from "../types.js";
import type { CrmProvider, ListOptions } from "./provider.js";
import { ProviderError } from "./provider.js";

interface EspoRecord { id: string; [key: string]: unknown; }

const entityNames: Record<EntityType, string> = {
  contacts: "Contact",
  companies: "Account",
  deals: "Opportunity",
  activities: "Task"
};

const propertyAliases: Partial<Record<EntityType, Record<string, string>>> = {
  contacts: { firstname: "firstName", lastname: "lastName" },
  companies: { domain: "website" },
  deals: { dealname: "name", dealstage: "stage", closedate: "closeDate" },
  activities: { subject: "name", hs_note_body: "description" }
};

export class EspoCrmProvider implements CrmProvider {
  readonly name = "espocrm";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly idempotencyField: string
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/${path}`, {
      ...init,
      headers: { "X-Api-Key": this.apiKey, "content-type": "application/json", ...init.headers }
    });
    if (response.status === 404) throw new ProviderError("EspoCRM record not found", false, 404);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ProviderError(`EspoCRM ${response.status}: ${detail}`, retryable, response.status);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private ensureSupported(entity: CrmEntity): void {
    if (Object.keys(entity.associations).length) {
      throw new ProviderError("EspoCRM associations require an explicit stable-link mapping and are not supported by the v1 adapter", false, 400);
    }
  }

  private properties(type: EntityType, properties: Record<string, unknown>): Record<string, unknown> {
    const aliases = propertyAliases[type] ?? {};
    const mapped = Object.fromEntries(Object.entries(properties).map(([name, value]) => [aliases[name] ?? name, value]));
    if (type === "activities" && !mapped.name) mapped.name = "CRM activity";
    return mapped;
  }

  private result(record: EspoRecord): ProviderWriteResult {
    const { id, ...properties } = record;
    return { providerId: id, properties, raw: record };
  }

  private async findByIdempotencyKey(type: EntityType, value: string): Promise<EspoRecord | null> {
    const where = JSON.stringify([{ type: "equals", attribute: this.idempotencyField, value }]);
    const query = new URLSearchParams({ maxSize: "1", where, select: `id,${this.idempotencyField}` });
    const page = await this.request<{ list?: EspoRecord[] }>(`${entityNames[type]}?${query}`);
    return page.list?.[0] ?? null;
  }

  async create(type: EntityType, entity: CrmEntity): Promise<ProviderWriteResult> {
    this.ensureSupported(entity);
    const existing = await this.findByIdempotencyKey(type, entity.id);
    if (existing) return await this.update(type, existing.id, entity);
    const record = await this.request<EspoRecord>(entityNames[type], {
      method: "POST",
      body: JSON.stringify({ ...this.properties(type, entity.properties), [this.idempotencyField]: entity.id })
    });
    return this.result(record);
  }

  async update(type: EntityType, providerId: string, entity: CrmEntity): Promise<ProviderWriteResult> {
    this.ensureSupported(entity);
    return this.result(await this.request<EspoRecord>(`${entityNames[type]}/${encodeURIComponent(providerId)}`, {
      method: "PUT", body: JSON.stringify(this.properties(type, entity.properties))
    }));
  }

  async delete(type: EntityType, providerId: string): Promise<void> {
    try {
      await this.request<unknown>(`${entityNames[type]}/${encodeURIComponent(providerId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
    }
  }

  async get(type: EntityType, providerId: string): Promise<ProviderWriteResult | null> {
    try {
      return this.result(await this.request<EspoRecord>(`${entityNames[type]}/${encodeURIComponent(providerId)}`));
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async list(type: EntityType, options: ListOptions): Promise<{ items: ProviderWriteResult[]; nextCursor?: string }> {
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderError("Invalid EspoCRM list cursor", false, 400);
    const query = new URLSearchParams({ maxSize: String(options.limit), offset: String(offset) });
    const page = await this.request<{ list?: EspoRecord[]; total?: number }>(`${entityNames[type]}?${query}`);
    const records = page.list ?? [];
    const nextOffset = offset + records.length;
    const hasNext = records.length === options.limit && (typeof page.total !== "number" || page.total < 0 || nextOffset < page.total);
    return { items: records.map((record) => this.result(record)), nextCursor: hasNext ? String(nextOffset) : undefined };
  }
}

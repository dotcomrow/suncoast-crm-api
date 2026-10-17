import { createHash } from "node:crypto";
import type { CrmEntity, EntityType, ProviderWriteResult } from "../types.js";
import type { CustomFieldDefinition, CustomObjectDefinition, CustomObjectDefinitionInput } from "../custom-objects.js";
import type { CrmProvider, EmailValidationResult, FormSubmission, ListOptions } from "./provider.js";
import { ProviderError } from "./provider.js";

interface HubSpotObject { id: string; properties?: Record<string, unknown>; }
interface HubSpotBatchResult { results?: HubSpotObject[]; errors?: Array<{ message?: string }> }
const objectNames: Record<EntityType, string> = {
  contacts: "contacts", companies: "companies", deals: "deals", activities: "notes"
};
const builtInIdempotencyProperties: Partial<Record<EntityType, string>> = { activities: "hs_unique_id" };
const standardPropertyGroups: Partial<Record<EntityType, string>> = {
  contacts: "contactinformation", companies: "companyinformation", deals: "dealinformation"
};
const confirmedEmailStatusLabels = new Set([
  "confirmed", "user clicked confirmation", "hubspot rep marked confirmed", "customer marked confirmed",
  "confirmed from previous behavior", "confirmed due to form"
]);

export class HubSpotProvider implements CrmProvider {
  readonly name = "hubspot";
  constructor(private readonly token: string, private readonly baseUrl: string, private readonly idempotencyProperty: string, private readonly formsBaseUrl = "https://api.hsforms.com") {}

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

  async submitForm(portalId: string, formId: string, submission: FormSubmission): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      submittedAt: Date.now(),
      fields: Object.entries(submission.fields).map(([name, value]) => ({ name, value }))
    };
    if (submission.context) body.context = submission.context;
    if (submission.consent) {
      body.legalConsentOptions = {
        consent: {
          consentToProcess: submission.consent.consentToProcess,
          text: submission.consent.text,
          communications: submission.consent.communications
        }
      };
    }
    const response = await fetch(`${this.formsBaseUrl}/submissions/v3/integration/secure/submit/${encodeURIComponent(portalId)}/${encodeURIComponent(formId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ProviderError(`HubSpot Forms ${response.status}: ${detail}`, retryable, response.status);
    }
    if (response.status === 204) return {};
    return await response.json() as Record<string, unknown>;
  }

  async getEmailValidation(email: string): Promise<EmailValidationResult> {
    let contact: HubSpotObject;
    try {
      contact = await this.request<HubSpotObject>(`/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=hs_emailconfirmationstatus`);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return { status: "pending", providerStatus: "CONTACT_NOT_FOUND" };
      throw error;
    }
    const providerStatus = typeof contact.properties?.hs_emailconfirmationstatus === "string"
      ? contact.properties.hs_emailconfirmationstatus : null;
    if (!providerStatus) return { status: "pending", providerStatus, providerContactId: contact.id };

    const property = await this.request<{ options?: Array<{ label?: string; value?: string }> }>("/crm/v3/properties/contacts/hs_emailconfirmationstatus");
    const label = property.options?.find((option) => option.value === providerStatus)?.label?.trim().toLowerCase();
    return {
      status: label && confirmedEmailStatusLabels.has(label) ? "validated" : "pending",
      providerStatus,
      providerContactId: contact.id
    };
  }

  private customProperty(field: CustomFieldDefinition) {
    const type = field.type === "boolean" ? "bool" : field.type === "datetime" ? "datetime" : field.type;
    const fieldType = field.type === "boolean" ? "booleancheckbox" : field.type === "date" || field.type === "datetime" ? "date" : field.type === "enumeration" ? "select" : field.type === "number" ? "number" : "text";
    return { name: field.name, label: field.label, type, fieldType, hasUniqueValue: field.unique, options: field.options };
  }

  private customRecordProperties(definition: CustomObjectDefinition, properties: Record<string, unknown>): Record<string, string> {
    const fields = new Map(definition.fields.map((field) => [field.name, field]));
    return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
      const field = fields.get(name);
      if (!field) throw new ProviderError(`Unknown custom object property ${name}`, false, 400);
      if (value === null) return [name, ""];
      return [name, typeof value === "string" ? value : String(value)];
    }));
  }

  private projectionPropertyName(objectName: string, fieldName: string): string {
    const raw = `suncoast_${objectName}_${fieldName}`;
    if (raw.length <= 95) return raw;
    return `${raw.slice(0, 82)}_${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
  }

  private async ensureContactProjectionProperty(objectName: string, field: CustomFieldDefinition): Promise<string> {
    const name = this.projectionPropertyName(objectName, field.name);
    try {
      await this.request<Record<string, unknown>>(`/crm/v3/properties/contacts/${encodeURIComponent(name)}`);
      return name;
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
    }
    try {
      await this.request<Record<string, unknown>>("/crm/v3/properties/contacts", {
        method: "POST", body: JSON.stringify({ ...this.customProperty(field), name, groupName: "contactinformation", hidden: true, formField: false })
      });
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 409)) throw error;
    }
    return name;
  }

  async defineContactPropertyProjection(definition: CustomObjectDefinitionInput): Promise<Record<string, unknown>> {
    const entries = await Promise.all(definition.fields.map(async (field) => [field.name, await this.ensureContactProjectionProperty(definition.name, field)] as const));
    return { propertyMap: Object.fromEntries(entries) };
  }

  async addContactPropertyProjectionFields(definition: CustomObjectDefinition, fields: CustomFieldDefinition[]): Promise<void> {
    await Promise.all(fields.map((field) => this.ensureContactProjectionProperty(definition.name, field)));
  }

  async writeContactPropertyProjection(definition: CustomObjectDefinition, contactProviderId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult> {
    const projected = Object.fromEntries(Object.entries(this.customRecordProperties(definition, properties)).map(([name, value]) => [this.projectionPropertyName(definition.name, name), value]));
    const item = await this.request<HubSpotObject>(`/crm/v3/objects/contacts/${encodeURIComponent(contactProviderId)}`, { method: "PATCH", body: JSON.stringify({ properties: projected }) });
    return this.result(item);
  }

  async clearContactPropertyProjection(definition: CustomObjectDefinition, contactProviderId: string): Promise<void> {
    const properties = Object.fromEntries(definition.fields.map((field) => [this.projectionPropertyName(definition.name, field.name), ""]));
    await this.request<HubSpotObject>(`/crm/v3/objects/contacts/${encodeURIComponent(contactProviderId)}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  }

  async defineCustomObject(definition: CustomObjectDefinitionInput): Promise<{ objectType: string; raw: Record<string, unknown> }> {
    const schemas = await this.request<{ results?: Array<Record<string, unknown>> }>("/crm/v3/schemas");
    const existing = schemas.results?.find((schema) => schema.name === definition.name);
    if (existing) {
      const objectType = String(existing.objectTypeId ?? existing.fullyQualifiedName ?? "");
      if (!objectType) throw new ProviderError(`HubSpot custom object ${definition.name} has no object type identifier`, false);
      return { objectType, raw: existing };
    }
    const raw = await this.request<Record<string, unknown>>("/crm/v3/schemas", {
      method: "POST",
      body: JSON.stringify({
        name: definition.name,
        labels: { singular: definition.singular_label, plural: definition.plural_label },
        primaryDisplayProperty: definition.primary_display_property,
        requiredProperties: definition.fields.filter((field) => field.required).map((field) => field.name),
        searchableProperties: definition.fields.filter((field) => field.type === "string" || field.type === "enumeration").map((field) => field.name),
        properties: [
          ...definition.fields.map((field) => this.customProperty(field)),
          { name: "suncoast_crm_id", label: "Suncoast CRM ID", type: "string", fieldType: "text", hasUniqueValue: true, hidden: true },
          { name: "suncoast_contact_id", label: "Suncoast Contact ID", type: "string", fieldType: "text", hidden: true }
        ],
        associatedObjects: ["CONTACT"]
      })
    });
    const objectType = String(raw.objectTypeId ?? raw.fullyQualifiedName ?? "");
    if (!objectType) throw new ProviderError("HubSpot custom object creation returned no object type identifier", true);
    return { objectType, raw };
  }

  async addCustomObjectFields(definition: CustomObjectDefinition, fields: CustomFieldDefinition[]): Promise<void> {
    if (!definition.provider_object_type) throw new ProviderError("Custom object has no provider object type", false);
    for (const field of fields) {
      try {
        await this.request<Record<string, unknown>>(`/crm/v3/properties/${encodeURIComponent(definition.provider_object_type)}`, {
          method: "POST", body: JSON.stringify(this.customProperty(field))
        });
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 409)) throw error;
      }
    }
  }

  async createCustomRecord(definition: CustomObjectDefinition, recordId: string, contactId: string, contactProviderId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult> {
    if (!definition.provider_object_type) throw new ProviderError("Custom object has no provider object type", false);
    const response = await this.request<HubSpotBatchResult>(`/crm/v3/objects/${encodeURIComponent(definition.provider_object_type)}/batch/upsert`, {
      method: "POST",
      body: JSON.stringify({ inputs: [{ id: recordId, idProperty: "suncoast_crm_id", objectWriteTraceId: recordId,
        properties: { ...this.customRecordProperties(definition, properties), suncoast_crm_id: recordId, suncoast_contact_id: contactId } }] })
    });
    const item = response.results?.[0];
    if (!item) throw new ProviderError(response.errors?.[0]?.message ?? "HubSpot custom object upsert returned no object", true);
    await this.request<Record<string, unknown>>(`/crm/v4/objects/${encodeURIComponent(definition.provider_object_type)}/${encodeURIComponent(item.id)}/associations/default/contacts/${encodeURIComponent(contactProviderId)}`, { method: "PUT" });
    return this.result(item);
  }

  async updateCustomRecord(definition: CustomObjectDefinition, providerId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult> {
    if (!definition.provider_object_type) throw new ProviderError("Custom object has no provider object type", false);
    return this.result(await this.request<HubSpotObject>(`/crm/v3/objects/${encodeURIComponent(definition.provider_object_type)}/${encodeURIComponent(providerId)}`, {
      method: "PATCH", body: JSON.stringify({ properties: this.customRecordProperties(definition, properties) })
    }));
  }

  async deleteCustomRecord(definition: CustomObjectDefinition, providerId: string): Promise<void> {
    if (!definition.provider_object_type) throw new ProviderError("Custom object has no provider object type", false);
    try { await this.request<void>(`/crm/v3/objects/${encodeURIComponent(definition.provider_object_type)}/${encodeURIComponent(providerId)}`, { method: "DELETE" }); }
    catch (error) { if (!(error instanceof ProviderError && error.status === 404)) throw error; }
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
      const groupName = standardPropertyGroups[entityType];
      if (!groupName) throw new Error(`No HubSpot property group is configured for ${entityType}`);
      const created = await fetch(`${baseUrl}/crm/v3/properties/${objectType}`, {
        method: "POST", headers, body: JSON.stringify({
          groupName, name: propertyName, label: "Suncoast CRM ID", description: "Stable identifier used by the Suncoast CRM API for idempotent synchronization.",
          type: "string", fieldType: "text", hasUniqueValue: true, hidden: true, formField: false
        })
      });
      if (!created.ok && created.status !== 409) {
        throw new Error(`Unable to create HubSpot ${objectType} idempotency property: ${created.status} ${(await created.text()).slice(0, 1000)}`);
      }
      continue;
    }
    if (!existing.ok) throw new Error(`Unable to inspect HubSpot ${objectType} property: ${existing.status} ${(await existing.text()).slice(0, 500)}`);
    const metadata = await existing.json() as { type?: string; hasUniqueValue?: boolean; modificationMetadata?: { readOnlyValue?: boolean } };
    if (metadata.type !== "string" || !metadata.hasUniqueValue || metadata.modificationMetadata?.readOnlyValue) {
      throw new Error(`HubSpot ${objectType} property '${propertyName}' must be a writable, unique single-line text property`);
    }
  }
}

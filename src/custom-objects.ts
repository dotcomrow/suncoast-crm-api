import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "./config.js";
import { inTransaction, pool } from "./db.js";
import { providerFor } from "./providers/registry.js";

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
export const customFieldDefinition = z.object({
  name: fieldName,
  label: z.string().trim().min(1).max(100),
  type: z.enum(["string", "number", "boolean", "date", "datetime", "enumeration"]),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  options: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).default([])
}).superRefine((field, context) => {
  if (field.type === "enumeration" && field.options.length === 0) context.addIssue({ code: "custom", message: "Enumeration fields require options" });
  if (field.type !== "enumeration" && field.options.length) context.addIssue({ code: "custom", message: "Only enumeration fields may define options" });
});

export const customObjectDefinitionSpec = z.object({
  singular_label: z.string().trim().min(1).max(100),
  plural_label: z.string().trim().min(1).max(100),
  primary_display_property: fieldName,
  fields: z.array(customFieldDefinition).min(1).max(100),
  storage_mode: z.enum(["local", "contact_properties", "provider_custom_object"]).default("local"),
  cardinality: z.enum(["one_per_contact", "many_per_contact"]).default("many_per_contact")
});

export const customObjectDefinitionBody = customObjectDefinitionSpec.extend({ name: fieldName }).superRefine((definition, context) => {
  const names = definition.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "Field names must be unique", path: ["fields"] });
  if (!names.includes(definition.primary_display_property)) context.addIssue({ code: "custom", message: "primary_display_property must name a declared field", path: ["primary_display_property"] });
  if (names.some((name) => name === "suncoast_crm_id" || name === "suncoast_contact_id")) context.addIssue({ code: "custom", message: "suncoast_crm_id and suncoast_contact_id are reserved", path: ["fields"] });
  if (definition.storage_mode === "contact_properties" && definition.cardinality !== "one_per_contact") context.addIssue({ code: "custom", message: "contact_properties storage requires one_per_contact cardinality", path: ["cardinality"] });
});

export const customRecordBody = z.object({
  contact_id: z.string().uuid(),
  properties: z.record(z.string(), z.unknown())
});
export const customRecordUpdateBody = z.object({
  properties: z.record(z.string(), z.unknown()).refine((properties) => Object.keys(properties).length > 0, "At least one property is required")
});
export const customObjectMigrationBody = z.object({
  add_fields: z.array(customFieldDefinition).min(1).max(100)
});

export type CustomObjectDefinitionInput = z.infer<typeof customObjectDefinitionBody>;
export type CustomFieldDefinition = CustomObjectDefinitionInput["fields"][number];

export interface CustomObjectDefinition extends CustomObjectDefinitionInput {
  id: string;
  provider: string;
  provider_object_type: string | null;
  provider_schema: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function definitionResponse(row: Record<string, unknown>): CustomObjectDefinition {
  return { id: String(row.id), name: String(row.name), singular_label: String(row.singular_label), plural_label: String(row.plural_label),
    primary_display_property: String(row.primary_display_property), fields: row.fields as CustomFieldDefinition[], provider: String(row.provider),
    storage_mode: row.storage_mode as CustomObjectDefinition["storage_mode"], cardinality: row.cardinality as CustomObjectDefinition["cardinality"],
    provider_object_type: row.provider_object_type as string | null, provider_schema: row.provider_schema as Record<string, unknown> | null,
    created_at: String(row.created_at), updated_at: String(row.updated_at) };
}

export async function createCustomObjectDefinition(tenantId: string, input: CustomObjectDefinitionInput): Promise<{ definition: CustomObjectDefinition; duplicate: boolean }> {
  const existing = await getCustomObjectDefinition(tenantId, input.name);
  if (existing) {
    const same = isDeepStrictEqual(input, { name: existing.name, singular_label: existing.singular_label, plural_label: existing.plural_label, primary_display_property: existing.primary_display_property, fields: existing.fields, storage_mode: existing.storage_mode, cardinality: existing.cardinality });
    if (!same) throw Object.assign(new Error("Custom object already exists with a different definition"), { status: 409 });
    return { definition: existing, duplicate: true };
  }
  const provider = providerFor(config().CRM_PROVIDER);
  let native: { objectType: string | null; raw: Record<string, unknown> } = { objectType: null, raw: {} };
  if (input.storage_mode === "provider_custom_object") {
    if (!provider.defineCustomObject) throw Object.assign(new Error(`Provider ${provider.name} does not support custom objects`), { status: 501 });
    native = await provider.defineCustomObject(input);
  } else if (input.storage_mode === "contact_properties") {
    if (!provider.defineContactPropertyProjection) throw Object.assign(new Error(`Provider ${provider.name} does not support contact-property projections`), { status: 501 });
    native = { objectType: "contacts", raw: await provider.defineContactPropertyProjection(input) };
  }
  const result = await pool.query(
    `INSERT INTO crm_custom_object_definitions (id,tenant_id,name,singular_label,plural_label,primary_display_property,fields,provider,storage_mode,cardinality,provider_object_type,provider_schema)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [randomUUID(), tenantId, input.name, input.singular_label, input.plural_label, input.primary_display_property, input.fields, provider.name, input.storage_mode, input.cardinality, native.objectType, native.raw]
  );
  return { definition: definitionResponse(result.rows[0]), duplicate: false };
}

export async function listCustomObjectDefinitions(tenantId: string) {
  const result = await pool.query("SELECT * FROM crm_custom_object_definitions WHERE tenant_id=$1 ORDER BY name", [tenantId]);
  return { items: result.rows.map(definitionResponse) };
}

export async function getCustomObjectDefinition(tenantId: string, name: string): Promise<CustomObjectDefinition | null> {
  const result = await pool.query("SELECT * FROM crm_custom_object_definitions WHERE tenant_id=$1 AND name=$2", [tenantId, name]);
  return result.rows[0] ? definitionResponse(result.rows[0]) : null;
}

export async function migrateCustomObjectDefinition(tenantId: string, name: string, additions: CustomFieldDefinition[]): Promise<CustomObjectDefinition> {
  const definition = await getCustomObjectDefinition(tenantId, name);
  if (!definition) throw Object.assign(new Error("Custom object not found"), { status: 404 });
  const currentNames = new Set(definition.fields.map((field) => field.name));
  const additionNames = additions.map((field) => field.name);
  if (new Set(additionNames).size !== additionNames.length) throw Object.assign(new Error("Added field names must be unique"), { status: 400 });
  const currentFields = new Map(definition.fields.map((field) => [field.name, field]));
  const incompatible = additions.filter((field) => currentNames.has(field.name) && !isDeepStrictEqual(currentFields.get(field.name), field));
  if (incompatible.length) throw Object.assign(new Error(`Fields already exist with different definitions: ${incompatible.map((field) => field.name).join(", ")}`), { status: 409 });
  const pending = additions.filter((field) => !currentNames.has(field.name));
  if (!pending.length) return definition;
  if (definition.fields.length + pending.length > 100) throw Object.assign(new Error("Custom objects may contain at most 100 application fields"), { status: 400 });
  const provider = providerFor(definition.provider);
  if (definition.storage_mode === "provider_custom_object") {
    if (!provider.addCustomObjectFields) throw Object.assign(new Error(`Provider ${provider.name} does not support custom object migrations`), { status: 501 });
    await provider.addCustomObjectFields(definition, pending);
  } else if (definition.storage_mode === "contact_properties") {
    if (!provider.addContactPropertyProjectionFields) throw Object.assign(new Error(`Provider ${provider.name} does not support contact-property migrations`), { status: 501 });
    await provider.addContactPropertyProjectionFields(definition, pending);
  }
  const result = await pool.query("UPDATE crm_custom_object_definitions SET fields=$3,updated_at=now() WHERE tenant_id=$1 AND name=$2 RETURNING *", [tenantId, name, [...definition.fields, ...pending]]);
  return definitionResponse(result.rows[0]);
}

export function validateCustomProperties(definition: CustomObjectDefinition, properties: Record<string, unknown>, partial = false): void {
  const fields = new Map(definition.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(properties)) if (!fields.has(name)) throw Object.assign(new Error(`Unknown property '${name}'`), { status: 400 });
  for (const field of definition.fields) {
    const value = properties[field.name];
    if (!partial && field.required && (value === undefined || value === null || value === "")) throw Object.assign(new Error(`Property '${field.name}' is required`), { status: 400 });
    if (value === undefined || value === null) continue;
    const valid = field.type === "string" ? typeof value === "string"
      : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : field.type === "boolean" ? typeof value === "boolean"
      : field.type === "date" ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      : field.type === "datetime" ? typeof value === "string" && !Number.isNaN(Date.parse(value))
      : typeof value === "string" && field.options.some((option) => option.value === value);
    if (!valid) throw Object.assign(new Error(`Property '${field.name}' has an invalid ${field.type} value`), { status: 400 });
  }
}

export async function assertContact(tenantId: string, contactId: string): Promise<void> {
  const result = await pool.query("SELECT 1 FROM crm_entities WHERE tenant_id=$1 AND id=$2 AND entity_type='contacts' AND deleted_at IS NULL", [tenantId, contactId]);
  if (!result.rowCount) throw Object.assign(new Error("Contact not found"), { status: 404 });
}

export async function assertCustomRecordCardinality(tenantId: string, definition: CustomObjectDefinition, contactId: string): Promise<void> {
  if (definition.cardinality !== "one_per_contact") return;
  const result = await pool.query("SELECT 1 FROM crm_custom_object_records WHERE tenant_id=$1 AND definition_id=$2 AND contact_id=$3 AND deleted_at IS NULL", [tenantId, definition.id, contactId]);
  if (result.rowCount) throw Object.assign(new Error("This custom object permits only one record per contact"), { status: 409 });
}

function recordResponse(row: Record<string, unknown>) {
  return { id: row.id, object_name: row.object_name, contact_id: row.contact_id, provider_id: row.provider_id, properties: row.properties,
    version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at };
}

export async function getCustomRecord(tenantId: string, objectName: string, id: string) {
  const result = await pool.query(`SELECT r.*,d.name AS object_name FROM crm_custom_object_records r JOIN crm_custom_object_definitions d ON d.id=r.definition_id
    WHERE r.tenant_id=$1 AND d.name=$2 AND r.id=$3 AND r.deleted_at IS NULL`, [tenantId, objectName, id]);
  return result.rows[0] ? recordResponse(result.rows[0]) : null;
}

export async function listCustomRecords(tenantId: string, objectName: string, limit: number, cursor?: string, contactId?: string) {
  const params: unknown[] = [tenantId, objectName, limit + 1];
  const clauses = ["r.tenant_id=$1", "d.name=$2", "r.deleted_at IS NULL"];
  if (cursor) { params.push(cursor); clauses.push(`r.id > $${params.length}`); }
  if (contactId) { params.push(contactId); clauses.push(`r.contact_id = $${params.length}`); }
  const result = await pool.query(`SELECT r.*,d.name AS object_name FROM crm_custom_object_records r JOIN crm_custom_object_definitions d ON d.id=r.definition_id WHERE ${clauses.join(" AND ")} ORDER BY r.id LIMIT $3`, params);
  const hasMore = result.rows.length > limit; const rows = result.rows.slice(0, limit);
  return { items: rows.map(recordResponse), nextCursor: hasMore ? rows.at(-1)?.id as string : undefined };
}

export async function persistCustomRecord(input: { tenantId: string; definitionId: string; id: string; contactId: string; singleton: boolean; providerId: string; properties: Record<string, unknown> }) {
  await inTransaction(async (client) => {
    await client.query(`INSERT INTO crm_custom_object_records (id,tenant_id,definition_id,contact_id,singleton_contact_id,provider_id,properties) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET contact_id=EXCLUDED.contact_id,singleton_contact_id=EXCLUDED.singleton_contact_id,provider_id=EXCLUDED.provider_id,properties=EXCLUDED.properties,version=crm_custom_object_records.version+1,updated_at=now(),deleted_at=NULL`,
      [input.id, input.tenantId, input.definitionId, input.contactId, input.singleton ? input.contactId : null, input.providerId, input.properties]);
  });
}

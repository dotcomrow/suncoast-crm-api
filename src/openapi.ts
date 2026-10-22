import { config } from "./config.js";

const entity = {
  type: "object", required: ["id", "type", "provider", "properties", "associations", "version", "created_at", "updated_at"],
  properties: {
    id: { type: "string", format: "uuid" }, type: { type: "string", enum: ["contacts", "companies", "deals", "activities"] },
    provider: { type: "string" }, provider_id: { type: "string", nullable: true }, properties: { type: "object", additionalProperties: true },
    associations: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } }, version: { type: "integer" },
    created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }
  }
};
const queued = { type: "object", required: ["operation_id", "status"], properties: {
  operation_id: { type: "string", format: "uuid" }, status: { type: "string", enum: ["queued", "processing", "retrying", "succeeded", "failed"] }, duplicate: { type: "boolean" },
  entity_id: { type: "string", format: "uuid" }, status_url: { type: "string" }
} };
const operation = { type: "object", required: ["id", "provider", "action", "status", "attempts", "created_at"], properties: {
  id: { type: "string", format: "uuid" }, provider: { type: "string" }, action: { type: "string", enum: ["create", "update", "delete", "ai.summarize", "custom.create", "custom.update", "custom.delete"] },
  entity_type: { type: "string", nullable: true }, entity_id: { type: "string", format: "uuid", nullable: true }, status: { type: "string", enum: ["queued", "processing", "retrying", "succeeded", "failed"] },
  result: { type: "object", nullable: true, additionalProperties: true }, error: { type: "string", nullable: true }, attempts: { type: "integer" }, correlation_id: { type: "string" },
  created_at: { type: "string", format: "date-time" }, started_at: { type: "string", format: "date-time", nullable: true }, finished_at: { type: "string", format: "date-time", nullable: true }
} };
const error = { type: "object", required: ["error"], properties: { error: { type: "string" }, details: {} } };
const idempotency = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } };
const entityType = { name: "entityType", in: "path", required: true, schema: { type: "string", enum: ["contacts", "companies", "deals", "activities"] } };
const entityId = { name: "entityId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const accepted = { description: "Durably queued", content: { "application/json": { schema: { $ref: "#/components/schemas/QueuedOperation" } } } };
const objectName = { name: "objectName", in: "path", required: true, schema: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" } };
const recordId = { name: "recordId", in: "path", required: true, schema: { type: "string", format: "uuid" } };

export function openApiSpec() {
  return {
    openapi: "3.0.3", info: { title: "Suncoast CRM API", version: "1.0.0", description: "Stable provider-neutral CRM contract. Writes are durable asynchronous operations." },
    servers: [{ url: config().OPENAPI_SERVER_URL }], security: [{ bearerAuth: [] }], tags: [{ name: "CRM" }, { name: "Email Verification" }, { name: "Custom Objects" }, { name: "Operations" }, { name: "AI" }],
    paths: {
      "/v1/email-verifications": {
        post: { tags: ["Email Verification"], operationId: "requestExternalEmailVerification", summary: "Send a confirmation email for an external signup", parameters: [idempotency], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/EmailVerificationRequest" } } } }, responses: { "202": { description: "Confirmation email accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/EmailVerification" } } } }, "200": { description: "Idempotent duplicate" }, "409": { $ref: "#/components/responses/Error" } } }
      },
      "/v1/email-verifications/{verificationId}": {
        get: { tags: ["Email Verification"], operationId: "getExternalEmailVerification", parameters: [{ name: "verificationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Verification status", content: { "application/json": { schema: { $ref: "#/components/schemas/EmailVerification" } } } }, "404": { $ref: "#/components/responses/Error" } } }
      },
      "/v1/external-signups/contacts": {
        post: { tags: ["Email Verification", "CRM"], operationId: "createExternalContactSignup", summary: "Create an external contact and send its confirmation email", parameters: [idempotency], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ExternalContactSignup" } } } }, responses: { "202": { description: "Contact queued and confirmation email accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/ExternalContactSignupAccepted" } } } }, "400": { $ref: "#/components/responses/Error" }, "409": { $ref: "#/components/responses/Error" } } }
      },
      "/v1/custom-objects": {
        get: { tags: ["Custom Objects"], operationId: "listCustomObjects", description: "Read-only definitions managed by deployment migrations.", responses: { "200": { description: "Registered custom object definitions" } } }
      },
      "/v1/custom-objects/{objectName}": {
        get: { tags: ["Custom Objects"], operationId: "getCustomObject", parameters: [objectName], responses: { "200": { description: "Custom object definition", content: { "application/json": { schema: { $ref: "#/components/schemas/CustomObjectDefinition" } } } }, "404": { $ref: "#/components/responses/Error" } } }
      },
      "/v1/custom-objects/{objectName}/records": {
        get: { tags: ["Custom Objects"], operationId: "listCustomObjectRecords", parameters: [objectName, { name: "contact_id", in: "query", schema: { type: "string", format: "uuid" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "cursor", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Custom record page" } } },
        post: { tags: ["Custom Objects"], operationId: "createCustomObjectRecord", parameters: [idempotency, objectName], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CustomObjectRecordWrite" } } } }, responses: { "202": accepted } }
      },
      "/v1/custom-objects/{objectName}/records/{recordId}": {
        get: { tags: ["Custom Objects"], operationId: "getCustomObjectRecord", parameters: [objectName, recordId], responses: { "200": { description: "Custom record", content: { "application/json": { schema: { $ref: "#/components/schemas/CustomObjectRecord" } } } }, "404": { $ref: "#/components/responses/Error" } } },
        patch: { tags: ["Custom Objects"], operationId: "updateCustomObjectRecord", parameters: [idempotency, objectName, recordId], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["properties"], properties: { properties: { type: "object", additionalProperties: true } } } } } }, responses: { "202": accepted } },
        delete: { tags: ["Custom Objects"], operationId: "deleteCustomObjectRecord", parameters: [idempotency, objectName, recordId], responses: { "202": accepted } }
      },
      "/v1/{entityType}": {
        get: { tags: ["CRM"], operationId: "listCrmEntities", parameters: [entityType, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "cursor", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Entity page", content: { "application/json": { schema: { $ref: "#/components/schemas/EntityPage" } } } } } },
        post: { tags: ["CRM"], operationId: "createCrmEntity", parameters: [idempotency, entityType], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/EntityWrite" } } } }, responses: { "202": accepted, "400": { $ref: "#/components/responses/Error" } } }
      },
      "/v1/{entityType}/{entityId}": {
        get: { tags: ["CRM"], operationId: "getCrmEntity", parameters: [entityType, entityId], responses: { "200": { description: "Entity", content: { "application/json": { schema: { $ref: "#/components/schemas/CrmEntity" } } } }, "404": { $ref: "#/components/responses/Error" } } },
        patch: { tags: ["CRM"], operationId: "updateCrmEntity", parameters: [idempotency, entityType, entityId], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/EntityWrite" } } } }, responses: { "202": accepted } },
        delete: { tags: ["CRM"], operationId: "deleteCrmEntity", parameters: [idempotency, entityType, entityId], responses: { "202": accepted } }
      },
      "/v1/operations/{operationId}": { get: { tags: ["Operations"], operationId: "getCrmOperation", parameters: [{ name: "operationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Operation state", content: { "application/json": { schema: { $ref: "#/components/schemas/Operation" } } } }, "404": { $ref: "#/components/responses/Error" } } } },
      "/v1/ai/summaries": {
        post: {
          tags: ["AI"], operationId: "createCrmSummary", parameters: [idempotency],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["entity_type", "entity_id"], properties: {
              entity_type: { type: "string", enum: ["contacts", "companies", "deals", "activities"] },
              entity_id: { type: "string", format: "uuid" }
            }
          } } } },
          responses: { "202": accepted }
        }
      },
      "/healthz": { get: { security: [], operationId: "health", responses: { "200": { description: "Process health" } } } },
      "/readyz": { get: { security: [], operationId: "readiness", responses: { "200": { description: "Database ready" }, "503": { description: "Not ready" } } } }
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, schemas: { CrmEntity: entity, Operation: operation, EntityPage: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/CrmEntity" } }, nextCursor: { type: "string" } } }, EntityWrite: { type: "object", properties: { properties: { type: "object", additionalProperties: true }, associations: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } } } },
      CustomObjectField: { type: "object", required: ["name", "label", "type"], properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" }, label: { type: "string" }, type: { type: "string", enum: ["string", "number", "boolean", "date", "datetime", "enumeration"] }, required: { type: "boolean", default: false }, unique: { type: "boolean", default: false }, options: { type: "array", items: { type: "object", required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } } } } },
      CustomObjectDefinitionWrite: { type: "object", required: ["name", "singular_label", "plural_label", "primary_display_property", "fields"], properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" }, singular_label: { type: "string" }, plural_label: { type: "string" }, primary_display_property: { type: "string" }, fields: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/CustomObjectField" } }, storage_mode: { type: "string", enum: ["local", "contact_properties", "provider_custom_object"], default: "local" }, cardinality: { type: "string", enum: ["one_per_contact", "many_per_contact"], default: "many_per_contact" } } },
      CustomObjectDefinition: { allOf: [{ $ref: "#/components/schemas/CustomObjectDefinitionWrite" }, { type: "object", required: ["id", "provider", "provider_object_type"], properties: { id: { type: "string", format: "uuid" }, provider: { type: "string" }, provider_object_type: { type: "string" }, duplicate: { type: "boolean" }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } }] },
      CustomObjectRecordWrite: { type: "object", required: ["contact_id", "properties"], properties: { contact_id: { type: "string", format: "uuid" }, properties: { type: "object", additionalProperties: true } } },
      CustomObjectRecord: { type: "object", required: ["id", "object_name", "contact_id", "properties", "version"], properties: { id: { type: "string", format: "uuid" }, object_name: { type: "string" }, contact_id: { type: "string", format: "uuid" }, provider_id: { type: "string", nullable: true }, properties: { type: "object", additionalProperties: true }, version: { type: "integer" }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } },
      EmailVerificationRequest: { type: "object", required: ["email"], additionalProperties: false, properties: { email: { type: "string", format: "email", maxLength: 320 }, purpose: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,62}$", default: "external-signup" } } },
      EmailVerification: { type: "object", required: ["id", "validation_id", "email", "purpose", "status", "expires_at", "created_at"], properties: { id: { type: "string", format: "uuid" }, validation_id: { type: "string", format: "uuid", description: "Compatibility alias used by platform validation subscribers." }, entity_id: { type: "string", format: "uuid", nullable: true, description: "Associated CRM contact for an external signup." }, email: { type: "string", format: "email" }, purpose: { type: "string" }, status: { type: "string", enum: ["pending", "verified", "expired"] }, expires_at: { type: "string", format: "date-time" }, verified_at: { type: "string", format: "date-time", nullable: true }, created_at: { type: "string", format: "date-time" }, duplicate: { type: "boolean" } } },
      ExternalContactSignup: { allOf: [{ $ref: "#/components/schemas/EntityWrite" }, { type: "object", required: ["properties"], properties: { purpose: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,62}$", default: "external-signup" } }, description: "External-only contact intake. properties.email (or properties.emailAddress) is required. The contact is queued immediately and receives a linked one-time confirmation email; notifications-purpose contact creation is idempotent per normalized email." }] },
      ExternalContactSignupAccepted: { allOf: [{ $ref: "#/components/schemas/QueuedOperation" }, { type: "object", required: ["email_verification"], properties: { email_verification: { $ref: "#/components/schemas/EmailVerification" } } }] },
      QueuedOperation: queued,
      Error: error
    }, responses: {
      Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
    } }
  };
}

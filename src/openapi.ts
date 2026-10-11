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
  id: { type: "string", format: "uuid" }, provider: { type: "string" }, action: { type: "string", enum: ["create", "update", "delete", "ai.summarize"] },
  entity_type: { type: "string", nullable: true }, entity_id: { type: "string", format: "uuid", nullable: true }, status: { type: "string", enum: ["queued", "processing", "retrying", "succeeded", "failed"] },
  result: { type: "object", nullable: true, additionalProperties: true }, error: { type: "string", nullable: true }, attempts: { type: "integer" }, correlation_id: { type: "string" },
  created_at: { type: "string", format: "date-time" }, started_at: { type: "string", format: "date-time", nullable: true }, finished_at: { type: "string", format: "date-time", nullable: true }
} };
const error = { type: "object", required: ["error"], properties: { error: { type: "string" }, details: {} } };
const idempotency = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } };
const entityType = { name: "entityType", in: "path", required: true, schema: { type: "string", enum: ["contacts", "companies", "deals", "activities"] } };
const entityId = { name: "entityId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const accepted = { description: "Durably queued", content: { "application/json": { schema: { $ref: "#/components/schemas/QueuedOperation" } } } };

export function openApiSpec() {
  return {
    openapi: "3.0.3", info: { title: "Suncoast CRM API", version: "1.0.0", description: "Stable provider-neutral CRM contract. Writes are durable asynchronous operations." },
    servers: [{ url: config().OPENAPI_SERVER_URL }], security: [{ bearerAuth: [] }], tags: [{ name: "CRM" }, { name: "Operations" }, { name: "AI" }],
    paths: {
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
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, schemas: { CrmEntity: entity, Operation: operation, EntityPage: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/CrmEntity" } }, nextCursor: { type: "string" } } }, EntityWrite: { type: "object", properties: { properties: { type: "object", additionalProperties: true }, associations: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } } } }, QueuedOperation: queued, Error: error }, responses: { Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } }
  };
}

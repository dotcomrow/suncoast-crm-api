import type { CrmEntity, EntityType, ProviderWriteResult } from "../types.js";
import type { CustomFieldDefinition, CustomObjectDefinition, CustomObjectDefinitionInput } from "../custom-objects.js";

export interface ListOptions { cursor?: string; limit: number; }
export interface FormSubmission {
  fields: Record<string, string>;
  context?: { pageUri?: string; pageName?: string; hutk?: string };
  consent?: { consentToProcess: true; text: string; communications: Array<{ value: true; subscriptionTypeId: number; text: string }> };
}

export interface CrmProvider {
  readonly name: string;
  create(type: EntityType, entity: CrmEntity): Promise<ProviderWriteResult>;
  update(type: EntityType, providerId: string, entity: CrmEntity): Promise<ProviderWriteResult>;
  delete(type: EntityType, providerId: string): Promise<void>;
  get(type: EntityType, providerId: string): Promise<ProviderWriteResult | null>;
  list(type: EntityType, options: ListOptions): Promise<{ items: ProviderWriteResult[]; nextCursor?: string }>;
  submitForm?(portalId: string, formId: string, submission: FormSubmission): Promise<Record<string, unknown>>;
  defineCustomObject?(definition: CustomObjectDefinitionInput): Promise<{ objectType: string; raw: Record<string, unknown> }>;
  addCustomObjectFields?(definition: CustomObjectDefinition, fields: CustomFieldDefinition[]): Promise<void>;
  defineContactPropertyProjection?(definition: CustomObjectDefinitionInput): Promise<Record<string, unknown>>;
  addContactPropertyProjectionFields?(definition: CustomObjectDefinition, fields: CustomFieldDefinition[]): Promise<void>;
  writeContactPropertyProjection?(definition: CustomObjectDefinition, contactProviderId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult>;
  clearContactPropertyProjection?(definition: CustomObjectDefinition, contactProviderId: string): Promise<void>;
  createCustomRecord?(definition: CustomObjectDefinition, recordId: string, contactId: string, contactProviderId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult>;
  updateCustomRecord?(definition: CustomObjectDefinition, providerId: string, properties: Record<string, unknown>): Promise<ProviderWriteResult>;
  deleteCustomRecord?(definition: CustomObjectDefinition, providerId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

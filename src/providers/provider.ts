import type { CrmEntity, EntityType, ProviderWriteResult } from "../types.js";

export interface ListOptions { cursor?: string; limit: number; }

export interface CrmProvider {
  readonly name: string;
  create(type: EntityType, entity: CrmEntity): Promise<ProviderWriteResult>;
  update(type: EntityType, providerId: string, entity: CrmEntity): Promise<ProviderWriteResult>;
  delete(type: EntityType, providerId: string): Promise<void>;
  get(type: EntityType, providerId: string): Promise<ProviderWriteResult | null>;
  list(type: EntityType, options: ListOptions): Promise<{ items: ProviderWriteResult[]; nextCursor?: string }>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

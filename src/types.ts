export const entityTypes = ["contacts", "companies", "deals", "activities"] as const;
export type EntityType = typeof entityTypes[number];
export type CommandAction = "create" | "update" | "delete" | "ai.summarize" | "custom.create" | "custom.update" | "custom.delete" | "form.submit";

export interface CrmEntity {
  id: string;
  type: EntityType;
  provider: string;
  providerId: string | null;
  properties: Record<string, unknown>;
  associations: Record<string, string[]>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmCommand {
  schemaVersion: 1;
  id: string;
  operationId: string;
  tenantId: string;
  provider: string;
  action: CommandAction;
  entityType?: string;
  entityId?: string;
  payload: Record<string, unknown>;
  correlationId: string;
  requestedAt: string;
}

export interface ProviderWriteResult {
  providerId: string;
  properties: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

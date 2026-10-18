import { z } from "zod";
import { entityTypes } from "./types.js";

export const entityBody = z.object({
  properties: z.record(z.string(), z.unknown()).default({}),
  associations: z.record(z.string(), z.array(z.string())).default({})
});
export const externalContactSignupBody = entityBody.extend({
  purpose: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).default("external-signup")
}).superRefine((value, context) => {
  const email = value.properties.email ?? value.properties.emailAddress;
  const parsed = z.string().trim().email().max(320).safeParse(email);
  if (!parsed.success) context.addIssue({ code: z.ZodIssueCode.custom, path: ["properties", "email"], message: "A valid contact email is required" });
});
export const updateBody = entityBody.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const aiBody = z.object({
  entity_type: z.enum(entityTypes),
  entity_id: z.string().uuid()
});

export const commandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  tenantId: z.string().min(1),
  provider: z.string().min(1),
  action: z.enum(["create", "update", "delete", "ai.summarize", "custom.create", "custom.update", "custom.delete"]),
  entityType: z.string().min(1).optional(),
  entityId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
  correlationId: z.string().min(1),
  requestedAt: z.string().datetime()
}).superRefine((command, context) => {
  if (!command.entityType || !command.entityId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "entityType and entityId are required" });
  }
});

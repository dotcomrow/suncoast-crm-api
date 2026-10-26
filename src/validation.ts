import { createHash } from "node:crypto";
import { z } from "zod";
import { entityTypes } from "./types.js";

export function externalContactSubjectId(subjectId: string | undefined, email: string): string {
  const explicit = subjectId?.trim();
  return explicit || `email:${email.trim().toLowerCase()}`;
}

export function externalContactOperationIdempotencyKey(subjectId: string, purpose: string, requestIdempotencyKey: string): string {
  if (purpose !== "notifications") return requestIdempotencyKey;
  return `notification-contact:${createHash("sha256").update(subjectId).digest("hex").slice(0, 32)}`;
}

function fallbackContactLastName(subjectId: string | undefined, email: unknown): string {
  const stableSubject = subjectId ?? `email:${String(email ?? "unknown").trim().toLowerCase()}`;
  const digest = createHash("sha256").update(stableSubject).digest();
  const numericSuffix = (digest.readUIntBE(0, 6) % 1_000_000_000_000).toString().padStart(12, "0");
  return `Subscriber-${numericSuffix}`;
}

export function externalContactProperties(properties: Record<string, unknown>, subjectId?: string): Record<string, unknown> {
  const firstName = properties.firstname ?? properties.firstName;
  const lastName = properties.lastname ?? properties.lastName;
  const email = properties.email ?? properties.emailAddress;
  const syntheticNotificationName = firstName === "Notification" && lastName === "Subscriber";
  const { email: _email, emailAddress: _emailAddress, email_verified: _emailVerified, email_verified_at: _emailVerifiedAt, ...identityProperties } = properties;
  return {
    ...identityProperties,
    ...((typeof firstName !== "string" || !firstName.trim()) ? { firstname: "Notification" } : {}),
    ...((typeof lastName !== "string" || !lastName.trim() || syntheticNotificationName) ? { lastname: fallbackContactLastName(subjectId, email) } : {})
  };
}

export const entityBody = z.object({
  properties: z.record(z.string(), z.unknown()).default({}),
  associations: z.record(z.string(), z.array(z.string())).default({})
});
export const externalContactSignupBody = entityBody.extend({
  purpose: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).default("external-signup"),
  subject_id: z.string().trim().min(1).max(512).optional(),
  primary_email: z.boolean().default(false)
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

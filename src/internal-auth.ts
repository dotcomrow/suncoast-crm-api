import { timingSafeEqual } from "node:crypto";

export function contactPurgeAuthorized(configured: string | undefined, authorization: string | undefined): boolean {
  const supplied = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  const configuredBytes = Buffer.from(configured);
  const suppliedBytes = Buffer.from(supplied);
  return configuredBytes.length === suppliedBytes.length && timingSafeEqual(configuredBytes, suppliedBytes);
}

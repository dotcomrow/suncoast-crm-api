import { config } from "../config.js";
import type { CrmProvider } from "./provider.js";
import { HubSpotProvider } from "./hubspot.js";

export function providerFor(name: string): CrmProvider {
  const cfg = config();
  if (name !== "hubspot") throw new Error(`Unsupported CRM provider: ${name}`);
  if (!cfg.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not configured");
  return new HubSpotProvider(cfg.HUBSPOT_ACCESS_TOKEN, cfg.HUBSPOT_BASE_URL, cfg.HUBSPOT_IDEMPOTENCY_PROPERTY, cfg.HUBSPOT_FORMS_BASE_URL);
}

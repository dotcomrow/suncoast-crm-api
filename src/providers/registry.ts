import { config } from "../config.js";
import type { CrmProvider } from "./provider.js";
import { EspoCrmProvider } from "./espocrm.js";

export function providerFor(name: string): CrmProvider {
  const cfg = config();
  if (name === "espocrm") {
    if (!cfg.ESPOCRM_API_KEY) throw new Error("ESPOCRM_API_KEY is not configured");
    return new EspoCrmProvider(cfg.ESPOCRM_API_KEY, cfg.ESPOCRM_BASE_URL, cfg.ESPOCRM_IDEMPOTENCY_FIELD);
  }
  throw new Error(`Unsupported CRM provider: ${name}`);
}

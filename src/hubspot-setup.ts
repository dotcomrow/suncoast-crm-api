import { config } from "./config.js";
import { ensureHubSpotIdempotencyProperties } from "./providers/hubspot.js";

const cfg = config();
if (!cfg.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not configured");
await ensureHubSpotIdempotencyProperties(cfg.HUBSPOT_ACCESS_TOKEN, cfg.HUBSPOT_BASE_URL, cfg.HUBSPOT_IDEMPOTENCY_PROPERTY);
console.log("HubSpot idempotency properties are created or validated and ready");

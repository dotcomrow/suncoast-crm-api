import { z } from "zod";

const bool = z.string().default("false").transform((value) => value === "true");
const env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool,
  CRM_TENANT_ID: z.string().trim().min(1).default("suncoast"),
  CRM_PROVIDER: z.string().default("hubspot"),
  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.string().url().default("https://api.hubapi.com"),
  HUBSPOT_FORMS_BASE_URL: z.string().url().default("https://api.hsforms.com"),
  HUBSPOT_IDEMPOTENCY_PROPERTY: z.string().trim().min(1).default("suncoast_crm_id"),
  HUBSPOT_PORTAL_ID: z.string().trim().min(1).optional(),
  HUBSPOT_FORM_IDS: z.string().default("{}").transform((raw, context) => {
    try {
      const value = JSON.parse(raw) as unknown;
      return z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/), z.string().uuid()).parse(value);
    } catch {
      context.addIssue({ code: "custom", message: "HUBSPOT_FORM_IDS must be a JSON object mapping form names to HubSpot form GUIDs" });
      return z.NEVER;
    }
  }),
  KAFKA_BROKERS: z.string().default("kafka.kafka.svc.internal.lan:9092"),
  KAFKA_CLIENT_ID: z.string().default("suncoast-crm-api"),
  KAFKA_CONSUMER_GROUP: z.string().default("suncoast-crm-provider-workers-v1"),
  KAFKA_COMMAND_TOPIC: z.string().default("crm.commands.v1"),
  KAFKA_RETRY_TOPIC_1M: z.string().default("crm.commands.retry.1m.v1"),
  KAFKA_RETRY_TOPIC_5M: z.string().default("crm.commands.retry.5m.v1"),
  KAFKA_RETRY_TOPIC_30M: z.string().default("crm.commands.retry.30m.v1"),
  KAFKA_RETRY_TOPIC_2H: z.string().default("crm.commands.retry.2h.v1"),
  KAFKA_RETRY_TOPIC_6H: z.string().default("crm.commands.retry.6h.v1"),
  KAFKA_RETRY_TOPIC_24H: z.string().default("crm.commands.retry.24h.v1"),
  KAFKA_EVENT_TOPIC: z.string().default("crm.events.v1"),
  KAFKA_EMAIL_VALIDATION_EVENT_TOPIC: z.string().default("crm.email-validation.events.v1"),
  KAFKA_EMAIL_VALIDATION_ACTION_TOPIC: z.string().default("crm.email-validation.actions.v1"),
  KAFKA_DLQ_TOPIC: z.string().default("crm.commands.dlq.v1"),
  KAFKA_SECURITY_PROTOCOL: z.enum(["PLAINTEXT", "SASL_PLAINTEXT", "SASL_SSL"]).default("SASL_PLAINTEXT"),
  KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).default("scram-sha-256"),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  OLLAMA_ENABLED: bool,
  OLLAMA_BASE_URL: z.string().url().default("http://ollama.ollama.svc.cluster.local:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:14b"),
  OPENAPI_SERVER_URL: z.string().default("/crm"),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  PROCESSING_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  PLATFORM_NOTIFICATION_SERVICE_URL: z.string().url().default("http://platform-notification-service.directus.svc.cluster.local:8080"),
  PLATFORM_NOTIFICATION_TOKEN: z.string().optional(),
  HUBSPOT_FAILURE_NOTIFICATION_EMAIL: z.string().email().default("administrator@suncoast.systems"),
  NOTIFICATION_OUTBOX_POLL_MS: z.coerce.number().int().positive().default(10000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
  EMAIL_VALIDATION_RULES_ENABLED: bool,
  KIE_SERVER_BASE_URL: z.string().url().default("http://kie-server-auth-proxy.drools.svc.cluster.local:8080/kie-server/services/rest/server"),
  KIE_EMAIL_VALIDATION_CONTAINER: z.string().default("email-validation-policy"),
  KIE_EMAIL_VALIDATION_SESSION: z.string().default("email-validation-ksession"),
  KIE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
}).superRefine((value, ctx) => {
  if ((value.KAFKA_SASL_USERNAME && !value.KAFKA_SASL_PASSWORD) || (!value.KAFKA_SASL_USERNAME && value.KAFKA_SASL_PASSWORD)) {
    ctx.addIssue({ code: "custom", message: "Kafka username and password must be configured together" });
  }
});

export type Config = z.infer<typeof env>;
let cached: Config | undefined;
export function config(): Config {
  cached ??= env.parse(process.env);
  return cached;
}

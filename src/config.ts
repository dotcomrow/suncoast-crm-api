import { z } from "zod";

const bool = z.string().default("false").transform((value) => value === "true");
const env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  EMAIL_CONFIRMATION_PORT: z.coerce.number().int().positive().default(8082),
  EMAIL_CONFIRMATION_PUBLIC_URL: z.string().url().default("https://login.suncoast.systems/crm-email-confirmation/confirm-email"),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(24),
  EMAIL_VERIFICATION_EXPIRY_SWEEP_MS: z.coerce.number().int().positive().default(60000),
  EMAIL_VERIFICATION_RECONCILE_MS: z.coerce.number().int().positive().default(30000),
  EXTERNAL_SIGNUP_EMAIL_VERIFICATION_ENABLED: bool,
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool,
  CRM_TENANT_ID: z.string().trim().min(1).default("suncoast"),
  CRM_PROVIDER: z.literal("espocrm").default("espocrm"),
  ESPOCRM_API_KEY: z.string().optional(),
  ESPOCRM_BASE_URL: z.string().url().default("http://espocrm.crm.svc.cluster.local"),
  ESPOCRM_IDEMPOTENCY_FIELD: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).default("cSuncoastCrmId"),
  KAFKA_BROKERS: z.string().default("kafka.kafka.svc.internal.lan:9092"),
  KAFKA_CLIENT_ID: z.string().default("suncoast-crm-api"),
  KAFKA_CONSUMER_GROUP: z.string().default("suncoast-crm-provider-workers-v1"),
  KAFKA_EMAIL_VALIDATION_CONSUMER_GROUP: z.string().default("suncoast-crm-email-validation-projectors-v1"),
  KAFKA_COMMAND_TOPIC: z.string().default("crm.commands.v1"),
  KAFKA_RETRY_TOPIC_1M: z.string().default("crm.commands.retry.1m.v1"),
  KAFKA_RETRY_TOPIC_5M: z.string().default("crm.commands.retry.5m.v1"),
  KAFKA_RETRY_TOPIC_30M: z.string().default("crm.commands.retry.30m.v1"),
  KAFKA_RETRY_TOPIC_2H: z.string().default("crm.commands.retry.2h.v1"),
  KAFKA_RETRY_TOPIC_6H: z.string().default("crm.commands.retry.6h.v1"),
  KAFKA_RETRY_TOPIC_24H: z.string().default("crm.commands.retry.24h.v1"),
  KAFKA_EVENT_TOPIC: z.string().default("crm.events.v1"),
  KAFKA_EMAIL_VALIDATION_EVENT_TOPIC: z.string().default("crm.email-validation.events.v1"),
  PLATFORM_NOTIFICATION_SERVICE_URL: z.string().url().default("http://platform-notification-service.directus.svc.cluster.local:8080"),
  PLATFORM_NOTIFICATION_TOKEN: z.string().min(32).optional(),
  CONTACT_PURGE_TOKEN: z.string().min(32).optional(),
  KAFKA_DLQ_TOPIC: z.string().default("crm.commands.dlq.v1"),
  KAFKA_SECURITY_PROTOCOL: z.enum(["PLAINTEXT", "SASL_PLAINTEXT", "SASL_SSL"]).default("SASL_PLAINTEXT"),
  KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).default("scram-sha-256"),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  OLLAMA_ENABLED: bool,
  OLLAMA_BASE_URL: z.string().url().default("http://ollama.ollama.svc.cluster.local:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:14b"),
  REDIS_CACHE_ENABLED: bool,
  REDIS_SENTINELS: z.string().default("redis-sentinel.redis.svc.cluster.local:26379"),
  REDIS_MASTER_NAME: z.string().default("mymaster"),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(120),
  OPENAPI_SERVER_URL: z.string().default("/crm"),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  PROCESSING_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8081)
}).superRefine((value, ctx) => {
  if ((value.KAFKA_SASL_USERNAME && !value.KAFKA_SASL_PASSWORD) || (!value.KAFKA_SASL_USERNAME && value.KAFKA_SASL_PASSWORD)) {
    ctx.addIssue({ code: "custom", message: "Kafka username and password must be configured together" });
  }
  if (value.REDIS_CACHE_ENABLED && !value.REDIS_PASSWORD) ctx.addIssue({ code: "custom", message: "REDIS_PASSWORD is required when Redis caching is enabled" });
});

export type Config = z.infer<typeof env>;
let cached: Config | undefined;
export function config(): Config {
  cached ??= env.parse(process.env);
  return cached;
}

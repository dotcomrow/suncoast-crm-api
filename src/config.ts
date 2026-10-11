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
  HUBSPOT_IDEMPOTENCY_PROPERTY: z.string().trim().min(1).default("suncoast_crm_id"),
  KAFKA_BROKERS: z.string().default("kafka.kafka.svc.internal.lan:9092"),
  KAFKA_CLIENT_ID: z.string().default("suncoast-crm-api"),
  KAFKA_CONSUMER_GROUP: z.string().default("suncoast-crm-provider-workers-v1"),
  KAFKA_COMMAND_TOPIC: z.string().default("crm.commands.v1"),
  KAFKA_EVENT_TOPIC: z.string().default("crm.events.v1"),
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
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  PROCESSING_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8081)
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

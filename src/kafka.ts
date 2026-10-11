import { Kafka, logLevel, type Producer } from "kafkajs";
import { config } from "./config.js";

let kafkaInstance: Kafka | undefined;
let producerInstance: Producer | undefined;
export function kafka(): Kafka {
  if (kafkaInstance) return kafkaInstance;
  const cfg = config();
  const credentials = cfg.KAFKA_SASL_USERNAME && cfg.KAFKA_SASL_PASSWORD
    ? { username: cfg.KAFKA_SASL_USERNAME, password: cfg.KAFKA_SASL_PASSWORD }
    : undefined;
  const sasl = !credentials ? undefined
    : cfg.KAFKA_SASL_MECHANISM === "plain" ? { mechanism: "plain" as const, ...credentials }
    : cfg.KAFKA_SASL_MECHANISM === "scram-sha-512" ? { mechanism: "scram-sha-512" as const, ...credentials }
    : { mechanism: "scram-sha-256" as const, ...credentials };
  kafkaInstance = new Kafka({
    clientId: cfg.KAFKA_CLIENT_ID,
    brokers: cfg.KAFKA_BROKERS.split(",").map((v) => v.trim()),
    ssl: cfg.KAFKA_SECURITY_PROTOCOL === "SASL_SSL",
    sasl,
    logLevel: logLevel.WARN
  });
  return kafkaInstance;
}
export async function producer(): Promise<Producer> {
  if (!producerInstance) { producerInstance = kafka().producer({ allowAutoTopicCreation: false }); await producerInstance.connect(); }
  return producerInstance;
}
export async function publish(topic: string, key: string, value: unknown): Promise<void> {
  await (await producer()).send({ acks: -1, topic, messages: [{ key, value: JSON.stringify(value), headers: { "content-type": "application/json", "schema-version": "1" } }] });
}

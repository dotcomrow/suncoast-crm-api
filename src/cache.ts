import { Redis } from "ioredis";
import { config } from "./config.js";

let client: Redis | undefined;

function redis(): Redis | null {
  const cfg = config();
  if (!cfg.REDIS_CACHE_ENABLED) return null;
  if (!client) {
    const sentinels = cfg.REDIS_SENTINELS.split(",").map((entry) => {
      const [host, port = "26379"] = entry.trim().split(":");
      return { host: host!, port: Number(port) };
    });
    client = new Redis({
      sentinels,
      name: cfg.REDIS_MASTER_NAME,
      password: cfg.REDIS_PASSWORD,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null
    });
    client.on("error", (error) => console.warn("Redis cache unavailable", error.message));
  }
  return client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const instance = redis();
  if (!instance) return null;
  try {
    if (instance.status === "wait") await instance.connect();
    const value = await instance.get(key);
    return value ? JSON.parse(value) as T : null;
  } catch (error) {
    console.warn("Redis cache read failed", error);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const instance = redis();
  if (!instance) return;
  try {
    if (instance.status === "wait") await instance.connect();
    await instance.set(key, JSON.stringify(value), "EX", config().REDIS_CACHE_TTL_SECONDS);
  } catch (error) {
    console.warn("Redis cache write failed", error);
  }
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  const instance = redis();
  if (!instance || !keys.length) return;
  try {
    if (instance.status === "wait") await instance.connect();
    await instance.del(...keys);
  } catch (error) {
    console.warn("Redis cache invalidation failed", error);
  }
}

export const entityCacheKey = (tenantId: string, type: string, id: string) => `crm:v1:${tenantId}:entity:${type}:${id}`;

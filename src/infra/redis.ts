import Redis from "ioredis";
import { env } from "./config";

let client: Redis | null = null;

export function redis(): Redis {
  client ??= new Redis(env.redisUrl, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
  return client;
}

export function newRedis(): Redis {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
}

export async function closeRedis() {
  if (client) {
    client.disconnect();
    client = null;
  }
}

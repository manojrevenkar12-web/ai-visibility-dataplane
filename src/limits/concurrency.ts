// A distributed semaphore: at most `limit` calls in flight per provider across all workers.
// Holders are a ZSET scored by expiry, so a crashed worker's slot frees itself.
import type Redis from "ioredis";

const ACQUIRE = `
-- KEYS: holders ; ARGV: now, ttl, limit, holder
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
return 1`;

export class Semaphore {
  constructor(private readonly r: Redis) {}

  async acquire(name: string, limit: number, holder: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    return (await this.r.eval(ACQUIRE, 1, `sem:{${name}}`, now, ttlMs, limit, holder)) === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.r.zrem(`sem:{${name}}`, holder);
  }

  async inFlight(name: string, now = Date.now()): Promise<number> {
    return this.r.zcount(`sem:{${name}}`, now, "+inf");
  }
}

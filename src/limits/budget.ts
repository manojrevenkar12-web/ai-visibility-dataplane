// A daily cost ceiling per project that concurrency cannot overrun.
//
// Before a provider call the worker reserves the call's cost; the reservation and the check are one
// Lua call against `spent + reserved`. After the call it settles: the reservation is released and the
// actual cost is added (a provider that bills failed calls is charged too). Reservations carry an
// expiry so a crashed worker's hold is released. Check-then-spend without the reservation overruns
// under concurrency; the drills measure by how much.
import type Redis from "ioredis";

const RESERVE = `
-- KEYS: spent, holds ; ARGV: now, amount_micros, ceiling_micros, holder, ttl_ms
local now = tonumber(ARGV[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, h in ipairs(expired) do redis.call('ZREM', KEYS[2], h); redis.call('HDEL', KEYS[2] .. ':amt', h) end
local held = 0
for _, v in ipairs(redis.call('HVALS', KEYS[2] .. ':amt')) do held = held + tonumber(v) end
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
if spent + held + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[5]), ARGV[4])
redis.call('HSET', KEYS[2] .. ':amt', ARGV[4], ARGV[2])
redis.call('EXPIRE', KEYS[1], 172800); redis.call('EXPIRE', KEYS[2], 172800); redis.call('EXPIRE', KEYS[2] .. ':amt', 172800)
return 1`;

const SETTLE = `
-- KEYS: spent, holds ; ARGV: holder, actual_micros
redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('HDEL', KEYS[2] .. ':amt', ARGV[1])
return redis.call('INCRBY', KEYS[1], ARGV[2])`;

const micros = (eur: number) => Math.round(eur * 1_000_000);

export class CostBudget {
  constructor(private readonly r: Redis) {}

  private keys(project: string, day: string) {
    return [`budget:{${project}:${day}}:spent`, `budget:{${project}:${day}}:holds`] as const;
  }

  async reserve(
    project: string,
    day: string,
    amountEur: number,
    ceilingEur: number,
    holder: string,
    ttlMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    const [spent, holds] = this.keys(project, day);
    return (await this.r.eval(RESERVE, 2, spent, holds, now, micros(amountEur), micros(ceilingEur), holder, ttlMs)) === 1;
  }

  async settle(project: string, day: string, holder: string, actualEur: number): Promise<number> {
    const [spent, holds] = this.keys(project, day);
    return Number(await this.r.eval(SETTLE, 2, spent, holds, holder, micros(actualEur))) / 1_000_000;
  }

  async spent(project: string, day: string): Promise<number> {
    return Number((await this.r.get(this.keys(project, day)[0])) ?? 0) / 1_000_000;
  }
}

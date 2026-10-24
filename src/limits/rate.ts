// Provider rate limits, shared by every worker.
//
// GCRA (the generic cell rate algorithm) in one Lua call: the key stores the theoretical arrival
// time; a request is allowed if it is not more than `burst` intervals early. A denied caller gets
// the exact wait. A provider's Retry-After pauses the whole provider, not just the worker that saw
// it: otherwise 47 other workers learn about the limit the hard way.
//
// The configured rate is a ceiling, not a promise: a provider can lower its limit without notice.
// So the effective rate adapts (AIMD, as TCP does): every 429 cuts it by 30% (at most once a
// second, however many workers saw a 429), and each second without one adds back 5% of the
// ceiling.
import type Redis from "ioredis";

const GCRA = `
-- KEYS: tat, pause, rate ; ARGV: now_ms, configured_per_second, burst
local now = tonumber(ARGV[1])
local pause = tonumber(redis.call('GET', KEYS[2]) or '0')
if pause > now then return math.max(1, math.ceil(pause - now)) end
local rate = math.min(tonumber(ARGV[2]), tonumber(redis.call('GET', KEYS[3]) or ARGV[2]))
local interval = 1000 / rate
local tolerance = interval * tonumber(ARGV[3])
local tat = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
if tat < now then tat = now end
local allow_at = tat - tolerance
-- Redis turns a Lua number into an integer by truncation: a 0.4 ms wait must not come back as 0 ("go")
if allow_at > now then return math.max(1, math.ceil(allow_at - now)) end
redis.call('SET', KEYS[1], tat + interval, 'PX', math.ceil(tolerance + interval + 1000))
return 0`;

const PAUSE = `
-- KEYS: pause ; ARGV: until_ms, now_ms
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', math.max(1, tonumber(ARGV[1]) - tonumber(ARGV[2]))) end
return 1`;

const DECREASE = `
-- KEYS: rate, adj ; ARGV: now, configured, factor, floor_share
local now = tonumber(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[2]) or '0')
local rate = tonumber(redis.call('GET', KEYS[1]) or ARGV[2])
if now - last < 1000 then return tostring(rate) end
rate = math.max(tonumber(ARGV[2]) * tonumber(ARGV[4]), rate * tonumber(ARGV[3]))
redis.call('SET', KEYS[1], tostring(rate), 'PX', 3600000)
redis.call('SET', KEYS[2], now, 'PX', 3600000)
return tostring(rate)`;

const INCREASE = `
-- KEYS: rate, adj ; ARGV: now, configured, step_share
local cur = redis.call('GET', KEYS[1])
if not cur then return ARGV[2] end
local now = tonumber(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[2]) or '0')
if now - last < 1000 then return cur end
local rate = math.min(tonumber(ARGV[2]), tonumber(cur) + tonumber(ARGV[2]) * tonumber(ARGV[3]))
if rate >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], tostring(rate), 'PX', 3600000) end
redis.call('SET', KEYS[2], now, 'PX', 3600000)
return tostring(rate)`;

export class RateLimiter {
  constructor(private readonly r: Redis) {}

  /** 0 = go now; otherwise milliseconds until a token is available. Takes the token on 0. */
  async acquire(provider: string, perSecond: number, burst: number, now = Date.now()): Promise<number> {
    return Number(
      await this.r.eval(GCRA, 3, `rl:{${provider}}:tat`, `rl:{${provider}}:pause`, `rl:{${provider}}:rate`, now, perSecond, burst),
    );
  }

  /** A 429: lower the shared rate (30% at most once a second, never below 10% of the ceiling). */
  async throttled(provider: string, configured: number, now = Date.now()): Promise<number> {
    return Number(await this.r.eval(DECREASE, 2, `rl:{${provider}}:rate`, `rl:{${provider}}:adj`, now, configured, 0.7, 0.1));
  }

  /** A success: climb back toward the ceiling by 5% of it per second. */
  async succeeded(provider: string, configured: number, now = Date.now()): Promise<number> {
    return Number(await this.r.eval(INCREASE, 2, `rl:{${provider}}:rate`, `rl:{${provider}}:adj`, now, configured, 0.05));
  }

  async effectiveRate(provider: string, configured: number): Promise<number> {
    return Math.min(configured, Number((await this.r.get(`rl:{${provider}}:rate`)) ?? configured));
  }

  /** The provider told us to back off: every worker waits until `untilMs`. */
  async pause(provider: string, untilMs: number, now = Date.now()): Promise<void> {
    await this.r.eval(PAUSE, 1, `rl:{${provider}}:pause`, untilMs, now);
  }
}

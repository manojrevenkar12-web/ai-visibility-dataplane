// A circuit breaker per provider, shared by all workers.
//
// Outcomes are counted in one-second buckets over a rolling window. When the window has enough
// calls and the failure rate passes the threshold, the circuit opens: no worker calls the provider
// until the cooldown ends. Then a few probe calls are let through (half-open); a successful probe
// closes the circuit, a failed one opens it again. Throttling (429) is not a failure here; the rate
// limiter handles it. Runs that meet an open circuit are deferred, not failed and not counted as an
// attempt.
import type Redis from "ioredis";

export type CircuitState = "closed" | "open" | "half_open";

const RECORD = `
-- KEYS: prefix-based ; ARGV: now, ok(1/0), window_ms, min_calls, failure_rate, cooldown_ms, prefix
local now = tonumber(ARGV[1])
local p = ARGV[7]
local bucket = math.floor(now / 1000)
local okk = p .. ':ok:' .. bucket
local errk = p .. ':err:' .. bucket
if ARGV[2] == '1' then redis.call('INCR', okk) else redis.call('INCR', errk) end
local ttl = math.ceil(tonumber(ARGV[3]) / 1000) + 2
redis.call('EXPIRE', okk, ttl); redis.call('EXPIRE', errk, ttl)
local state = redis.call('GET', p .. ':state') or 'closed'
if state == 'half_open' then
  if ARGV[2] == '1' then
    redis.call('SET', p .. ':state', 'closed'); redis.call('DEL', p .. ':probes')
    return 'closed'
  end
  redis.call('SET', p .. ':state', 'open'); redis.call('SET', p .. ':open_until', now + tonumber(ARGV[6]))
  return 'open'
end
if state == 'open' then return 'open' end
local ok, err = 0, 0
local nb = math.ceil(tonumber(ARGV[3]) / 1000)
for i = 0, nb - 1 do
  ok = ok + tonumber(redis.call('GET', p .. ':ok:' .. (bucket - i)) or '0')
  err = err + tonumber(redis.call('GET', p .. ':err:' .. (bucket - i)) or '0')
end
if ok + err >= tonumber(ARGV[4]) and err / (ok + err) >= tonumber(ARGV[5]) then
  redis.call('SET', p .. ':state', 'open'); redis.call('SET', p .. ':open_until', now + tonumber(ARGV[6]))
  redis.call('INCR', p .. ':opened')
  return 'open'
end
return 'closed'`;

const ALLOW = `
-- ARGV: now, probes, prefix ; returns: 0 allowed, >0 ms to wait
local p = ARGV[3]
local now = tonumber(ARGV[1])
local state = redis.call('GET', p .. ':state') or 'closed'
if state == 'closed' then return 0 end
if state == 'open' then
  local until_ms = tonumber(redis.call('GET', p .. ':open_until') or '0')
  if now < until_ms then return until_ms - now end
  redis.call('SET', p .. ':state', 'half_open'); redis.call('SET', p .. ':probes', 0)
end
local n = redis.call('INCR', p .. ':probes')
if n <= tonumber(ARGV[2]) then return 0 end
return 200`;

export interface CircuitConfig {
  window_ms: number;
  min_calls: number;
  failure_rate: number;
  cooldown_ms: number;
  probes: number;
}

export class CircuitBreaker {
  constructor(private readonly r: Redis) {}

  private p(provider: string) {
    return `cb:{${provider}}`;
  }

  /** 0 = call the provider; otherwise wait this long (the circuit is open). */
  async allow(provider: string, cfg: CircuitConfig, now = Date.now()): Promise<number> {
    return Number(await this.r.eval(ALLOW, 0, now, cfg.probes, this.p(provider)));
  }

  async record(provider: string, ok: boolean, cfg: CircuitConfig, now = Date.now()): Promise<CircuitState> {
    return (await this.r.eval(
      RECORD,
      0,
      now,
      ok ? 1 : 0,
      cfg.window_ms,
      cfg.min_calls,
      cfg.failure_rate,
      cfg.cooldown_ms,
      this.p(provider),
    )) as CircuitState;
  }

  async state(provider: string): Promise<CircuitState> {
    return ((await this.r.get(`${this.p(provider)}:state`)) as CircuitState) ?? "closed";
  }

  async timesOpened(provider: string): Promise<number> {
    return Number((await this.r.get(`${this.p(provider)}:opened`)) ?? 0);
  }
}

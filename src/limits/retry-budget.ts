// A retry budget per provider (the Finagle/gRPC idea): retries may add at most `ratio` on top of
// first attempts over the last few seconds, plus a small floor. Without it, every worker retrying a
// failing provider multiplies the load exactly when the provider can least take it. A retry over
// budget is not dropped: the run is pushed back by the caller and tried later.
import type Redis from "ioredis";

const SPEND = `
-- ARGV: now, is_retry, ratio, min_per_second, prefix, window_s
local now = tonumber(ARGV[1])
local b = math.floor(now / 1000)
local p = ARGV[5]
local w = tonumber(ARGV[6])
if ARGV[2] == '0' then
  redis.call('INCR', p .. ':first:' .. b); redis.call('EXPIRE', p .. ':first:' .. b, w + 2)
  return 1
end
local first, retries = 0, 0
for i = 0, w - 1 do
  first = first + tonumber(redis.call('GET', p .. ':first:' .. (b - i)) or '0')
  retries = retries + tonumber(redis.call('GET', p .. ':retry:' .. (b - i)) or '0')
end
local allowed = first * tonumber(ARGV[3]) + tonumber(ARGV[4]) * w
if retries + 1 > allowed then return 0 end
redis.call('INCR', p .. ':retry:' .. b); redis.call('EXPIRE', p .. ':retry:' .. b, w + 2)
return 1`;

export class RetryBudget {
  constructor(
    private readonly r: Redis,
    private readonly windowS = 10,
  ) {}

  /** Records the call; for a retry, returns false when the budget is spent (do not call now). */
  async spend(provider: string, isRetry: boolean, ratio: number, minPerSecond: number, now = Date.now()): Promise<boolean> {
    return (await this.r.eval(SPEND, 0, now, isRetry ? 1 : 0, ratio, minPerSecond, `rb:{${provider}}`, this.windowS)) === 1;
  }
}

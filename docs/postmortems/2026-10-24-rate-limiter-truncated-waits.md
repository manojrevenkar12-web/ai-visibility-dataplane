# Postmortem: the shared rate limiter let through six times its rate

Found by: drill `steady`, third run (after the lease fix), which saw 257 429s. Severity, had it
shipped: page-level. Every provider would have throttled us continuously, and the retries would
have eaten the retry budget.

## What happened

With the limiter configured at 18 requests per second for AI Overview, the provider ledger showed
up to 36 requests in one second, and 257 429s across providers in a drill that should have had none.
A direct test of the limiter (100 concurrent callers, 18/s, burst 5, 3 s) granted
**116 tokens per second**.

## Why

The limiter is GCRA in a Redis Lua script. When a caller is early, the script returns the wait
in milliseconds: `allow_at - now`. With an interval of 1000/18 = 55.6 ms, that is often a
fraction, such as 0.4 ms. **Redis converts a Lua number reply to an integer by truncation**, so 0.4
arrived as 0, and the caller read 0 as "go". The script had not taken a token on that path, so
the caller went without one.

Earlier drills had not shown it, because before the lease fix workers spent most of their time
in long sleeps and rarely asked the limiter in that sub-millisecond window.

## Fix

Waits are rounded up and never below 1 ms (`math.max(1, math.ceil(...))`), for the GCRA wait and
for the provider pause. The same test then granted 23, 18 and 18 tokens in the three seconds
(burst, then the rate), and the `steady` drill saw **0** 429s.

## What we keep

- A regression test: concurrent callers get the configured rate within the burst
  (`test/integration/limits.test.ts`, "admits the configured rate"), and a fractional wait is
  never reported as 0.
- A review rule for Lua scripts: integer replies only. Round explicitly.
- An alert on our own 429s (`ThrottledByProvider`). A correct shared limiter means a 429 is news.
- We still run at 90% of each provider's limit (`config/providers.yaml`) for reasons the
  simulator does not model. At 100% the simulated providers also saw 0 429s
  ([data](data/steady-limiter-at-100pct.json)), so the headroom is judgement, not a measurement.

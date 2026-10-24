# Postmortem: a provider lowered its limit and the backlog took twice as long to clear

Found by: drill `limit_drop`. Severity, had it shipped: freshness. Customers' answers from one
provider arrive up to minutes late after the provider silently lowers our limit.

## What happened

One second into the drill the OpenAI-style provider's real limit dropped from 40 to 12 requests
a second; our configuration still allowed 36. The run finished, with every run collected and none
counted twice, but it took **156 s instead of about 35 s** and caused **238 429s**. The last
answers became visible 156 s after they were scheduled.

Source: [`data/limit-drop-before-adaptive-rate.json`](data/limit-drop-before-adaptive-rate.json).

## Why

Every 429 paused the provider for all workers for its Retry-After (1 s). When the pause ended,
the shared limiter released requests at the *configured* 36 a second again, the provider refused
everything above 12, and the next pause began. The system only ever learned "wait", never "slower".

## Fix

The shared limiter's rate now adapts, as TCP does (additive increase, multiplicative decrease):
each 429 cuts the effective rate by 30%, at most once a second however many workers saw a 429,
with a floor of 10% of the configured rate. Each second without a 429 adds back 5% of the
configured rate, up to the configured ceiling. The effective rate is shown in `/v1/ops/providers`
and as `avd_provider_effective_rate`.

| | Before | After |
|---|---|---|
| Drill duration | 156 s | 72 s |
| 429s caused | 238 | 101 |
| Freshness p95 / max | 45 s / 156 s | 40 s / 72 s |
| Runs collected / counted twice | 3,000 / 0 | 3,000 / 0 |

The remaining 429s are the price of probing: AIMD oscillates around the real limit. A provider
that publishes its remaining quota in response headers would let the limiter skip the probing.
None of the simulated ones do.

## What we keep

- The alert `ThrottledByProvider`: the adaptation keeps the system running, but someone still
  needs to find out why the limit changed and update `config/providers.yaml`.
- A test of the AIMD steps and floor (`limits.test.ts`, "the shared rate adapts").

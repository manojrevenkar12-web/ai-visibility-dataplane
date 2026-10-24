# ADR 0003: Provider limits, circuit breakers, retry budgets and cost ceilings are shared state

Status: accepted

## Context
A per-process rate limiter is wrong as soon as there are two workers, and the worker count changes
with autoscaling. Per-process circuit breakers each need their own failures to open, so N workers
send N times the probe traffic to a provider that is down. Per-process retries multiply load
during an outage. A per-process budget check lets concurrent calls overrun a cost ceiling.

## Decision
Every limit lives in Redis and is enforced with one Lua call:
- **Rate**: GCRA per provider at 90% of the provider's limit; a 429 pauses the provider for every
  worker for its Retry-After, and lowers the shared rate (multiplicative decrease, additive
  increase) until the provider stops refusing.
- **Concurrency**: a semaphore per provider, whose holders expire.
- **Circuit breaker**: rolling one-second buckets; when open, runs are deferred without spending an
  attempt; half-open lets a fixed number of probes through.
- **Retry budget**: retries may add at most 20% of first attempts (plus a floor), so an outage
  does not multiply load.
- **Cost ceiling**: reserve the call's cost before calling, settle after; reservations expire.

## Consequences
+ Measured against the naive worker in the drills: calls to a provider that is down, 429s caused,
  budget overrun (see `reports/DRILLS.md`).
− Each call costs a few Redis round trips, about 1 ms. That is negligible next to a provider call.
− Redis unavailable means no calls. The worker stops leasing rather than calling without limits.

# Architecture

```
            ┌──────────────┐  plan slot (idempotent run ids)   ┌──────────────────────────┐
 prompts ──▶│  scheduler   │──────────────────────────────────▶│ Postgres: run (pending)  │
            │ (fenced lock)│◀── reconcile: queued in PG, lost ─┤ the record of every run  │
            └──────┬───────┘    in Redis -> pending again      └──────────┬───────────────┘
                   │ feed up to high-water mark (backpressure)            │
                   ▼                                                      │ fenced writes:
            ┌──────────────┐ lease + fence + heartbeat ┌────────────┐     │ result + analytics outbox
            │ Redis queue  │──────────────────────────▶│  workers   │─────┤ + event outbox, one tx
            │ ready/leased │◀── retry (jitter) / defer ─│ (N pods)   │     │
            └──────────────┘                            └─────┬──────┘     ▼
   shared limits in Redis, checked per call:                  │       ┌──────────┐  dedup token,   ┌────────────┐
   circuit · retry budget · GCRA rate (AIMD) ·                ▼       │ shipper  │ ReplacingMerge  │ ClickHouse │
   concurrency · cost reservation                     ┌───────────────┤ (outbox) │────────────────▶│ FINAL      │
                                                      │  providers    └──────────┘                 └─────┬──────┘
                                                      │ (simulated)   ┌──────────┐ signed, retried       │
                                                      └───────────────┤ webhooks │──────▶ customer     API (Elysia)
                                                                      └──────────┘
```

## A run's life
1. **Planned**: the scheduler (one leader, with a fenced Redis lock checked again in Postgres)
   inserts one row per prompt × provider × country × slot. The id is a hash of those, so planning
   twice is a no-op.
2. **Queued**: pending runs move into the Redis lease queue, oldest first, while the queue is
   below its high-water mark. Above it, runs stay pending in Postgres (backpressure).
3. **Leased**: a worker leases a run and gets a fence (a strictly increasing number). It renews
   the lease for as long as it holds the run. It claims the run in Postgres with the fence, so
   any older lease is now void.
4. **Checked**: circuit closed? retry budget (only for retries caused by the provider)? rate token
   (GCRA, adaptive)? concurrency slot? cost reservation within the project's daily ceiling?
   Anything that cannot go now defers the run without spending an attempt.
5. **Called**: the call is written to the cost ledger *before* it is made, then updated with the
   result. Failures are typed: throttled, unavailable, truncated, schema drift, rejected.
6. **Recorded**: result, analytics payload and `run.completed` event in one Postgres transaction,
   applied only if the run still carries this lease's fence. Then the queue ack, also fenced.
7. **Shipped**: the shipper drains the analytics outbox into ClickHouse with a deduplication
   token. The webhook deliverer fans events out to endpoints and delivers them signed, with retries.

## Where each guarantee comes from

| Guarantee | Mechanism | Proven by |
|---|---|---|
| No run lost | Postgres record + reconciler; leases return work from dead workers; run deadline reports what cannot be collected | drill `crash` (workers killed, queue dropped) |
| No run counted twice | fenced writes; outbox → ClickHouse with dedup token + ReplacingMergeTree + FINAL | drill `crash` (shipper killed after insert), test "shipping the same outbox twice" |
| No paying twice for one run | lease renewed while held; no call after the lease is lost | postmortem: lease-expiry double spend; invariant "successful calls per run ≤ 1" |
| Provider limits respected | shared GCRA at 90% of the limit; Retry-After pauses everyone; AIMD when the provider lowers its limit | drills `steady`, `limit_drop` |
| No load spike on a provider that is down | shared circuit breaker; retry budget | drill `outage` vs baseline |
| Cost ceiling holds | reservation before the call (Lua), settle after, expiry counts as spent | drill `budget` vs baseline |
| Ledger never under-counts the invoice | write-ahead call record; timeouts counted | drill gate check on every drill |
| Format change does not lose or re-buy data | drift is not retried; body quarantined; reparse after the fix | drill `drift` |
| Webhooks arrive | outbox, at-least-once, stable webhook-id, signatures, backoff, auto-disable | every drill (receiver fails 10–30%) |

## Scale
The job this was built for describes millions of chats a month. At 3M runs a month (about 1.2 per second on average,
with daily peaks) the work splits like this:
- **Postgres**: about 7 statements per run, roughly 10 writes per second on average. One primary
  handles that easily. The `provider_call` ledger is the first table to move to ClickHouse at 10×.
- **Redis**: under 20 commands per run.
- **Workers**: providers, not workers, are the bottleneck. One process held 48 runs in flight
  on one core in the drills.
- **ClickHouse**: about 10 rows per run, inserted in batches of 500.

The drills run 3,000 runs in about 35 s on a 2-core container. That is set by the slowest
provider's rate: AI Overview allows 18 a second, so its 600 runs take about 33 s.

# ADR 0001: Postgres is the record; Redis is a work queue that can be rebuilt; ClickHouse is fed from an outbox

Status: accepted

## Context
A run moves through several systems: it is scheduled, queued, called, parsed, stored, counted in
analytics and announced by webhook. Each system can fail on its own (a Redis failover that drops
recent writes, a ClickHouse insert whose acknowledgement is lost, a pod killed mid-call). The
requirement is that no run is lost and none is counted twice, without distributed transactions.

## Decision
- **Postgres holds the truth about each run**: status, attempts, the lease fence that last wrote
  it, the result, every provider call and its cost.
- **Redis holds work in flight**: the lease queue, rate limiters, circuit breakers and budgets. If
  Redis loses the queue, the scheduler's reconciler finds runs that Postgres says are queued and
  Redis does not have, and queues them again.
- **ClickHouse is written only from an outbox** that the worker writes in the same transaction
  as the result. The shipper drains it. A retried batch carries the same deduplication token, and
  ReplacingMergeTree keyed by run (version = fence) collapses whatever remains. Queries read FINAL.
- **Webhooks also come from an outbox** written in the same transaction, delivered at least once
  with a stable `webhook-id` for receivers to deduplicate on.

## Consequences
+ Each guarantee has one owner and one test (see `reports/DRILLS.md`, drill `crash`).
+ Redis can run without persistence guarantees beyond what it gives; correctness never depends on it.
− Postgres sees every state change, about 6 statements per run. At 1M runs a day that is about 70
  writes a second, comfortable for one primary. At 10M+ the provider_call ledger would move to
  ClickHouse and the run table would be partitioned by slot.
− FINAL costs query time on large ranges. The mitigation is a nightly OPTIMIZE ... FINAL on
  closed partitions, or argMax views; not needed at this size.

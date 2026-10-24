# ADR 0002: A lease queue on Redis instead of Pub/Sub, Cloud Tasks or RabbitMQ (build vs buy)

Status: accepted for this repository; revisit per environment

## Context
Runs need: delayed retries with jitter; deferral without spending an attempt (circuit open, rate
limit); visibility timeouts with heartbeats; fencing so a stalled worker cannot complete work that
was handed on; idempotent enqueue by run id; and depth for autoscaling and backpressure.

| Option | Fits | Gaps for this workload |
|---|---|---|
| GCP Pub/Sub | managed, scales, ack deadlines, DLQ | no per-message delay; ordering keys only; no fencing token (ack ids are not monotonic); dedupe is best-effort |
| Cloud Tasks | per-task schedule time, named-task dedupe, rate limits per queue | push only, rate limits per queue not shared with other callers; a deferral is a new task |
| RabbitMQ | mature, delayed-message plugin, quorum queues | redelivery is not fenced; a delay needs a plugin or TTL+DLX; we would still need Redis for limiters |
| Redis lease queue (this) | all of the above in ~150 lines of Lua, plus the limiters live next to it | we own it: tests and drills are the price |

## Decision
Build the queue on Redis (`src/queue/queue.ts`): sorted sets for ready and leased jobs, a global
fence counter, all transitions in Lua. Postgres stays the record (ADR 0001), so losing Redis loses
no work.

## Consequences
+ One dependency for queue, rate limits, circuit state and budgets, with one consistency model.
+ The drills test the exact failure modes we care about (lease expiry, crash after call, queue loss).
− Throughput is bounded by one Redis primary per queue: tens of thousands of transitions a second, far above
  current need (1M pages a month is about 0.4 a second on average). Above that, shard queues by provider (the
  keys already carry a hash tag per queue).
− If the platform standardises on Pub/Sub, the same semantics can be kept with Pub/Sub for
  delivery and Postgres fences for writes; the worker's checks do not change.

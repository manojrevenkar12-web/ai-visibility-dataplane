# ai-visibility-dataplane

**The backend behind AI-search visibility analytics.** It runs thousands of tracked prompts against
ChatGPT-, Claude-, Perplexity-, Gemini- and AI-Overview-style providers that fail the way real
ones do, extracts which brands each answer mentions and which pages it cites, and lands everything
in ClickHouse **exactly once**. Through all of this it stays inside every provider's rate limit and
every customer's daily cost ceiling, and delivers signed webhooks.

TypeScript on Bun (Elysia API), Postgres, Redis, ClickHouse, Prometheus, OpenTelemetry and
Grafana. Kubernetes manifests with KEDA autoscaling on queue depth.

Most open-source "AI visibility trackers" (465 repositories carry the topic on GitHub) are
dashboards over a loop that asks a model about a brand. This repository is about the part under
the dashboard: queues, retries, rate limits, idempotency, locks, webhooks and cost ceilings. It is
tested by **fault drills** that kill workers, take providers down, change their limits and response
formats, and drop the queue. Each drill is judged from the provider's own request ledger and
compared with the worker most teams write first.

## Results

### Fault drills
`bun run src/cmd/drill.ts`, gated by `src/cmd/gate.ts` (83 checks, all passing; CI runs the drills
against real ClickHouse). 3,000 runs per drill: 24 customers × 25 prompts × 5 providers. Full
report: [reports/DRILLS.md](reports/DRILLS.md).

| Drill | What breaks | This data plane | Naive worker, same faults |
|---|---|---|---|
| `outage` | Perplexity answers 503 for 4.5 s; Gemini hangs for 3 s | 3,000/3,000 collected; **47** calls to Perplexity while it was down; 0 429s | 1,879 collected; **395** calls to Perplexity while down; 3,464 429s |
| `limit_drop` | OpenAI's real limit drops from 40 to 12/s; config still says 36 | 3,000/3,000 collected in 72 s; 101 429s (the shared rate adapts) | 1,653 collected; 4,693 429s |
| `crash` | 3% of calls followed by `kill`; 20% of ClickHouse batches followed by a crash; the queue is dropped at 3 s | 2,999 collected, 1 reported failed, **0 lost, 0 duplicates**, 88 worker restarts | **50 lost, 388 duplicate rows** |
| `budget` | Half the customers have a €0.40 ceiling for ~€1.20 of prompts, 96 calls in flight | **0** customers over budget; 1,009 runs reported "skipped: budget" | 12 customers over budget, by up to €0.57 |
| `drift` | OpenAI-style API changes its response shape mid-run | 550 answers kept in quarantine, then **all 550 recovered** after the parser fix, with **no extra provider calls** | – |
| `steady` | 1% errors, truncated bodies, slow tail, a webhook receiver failing 30% | 3,000/3,000; 0 429s; ledger €28.41 vs provider bill €28.40; 3,000/3,000 webhooks delivered | – |

The naive worker has no shared limiter, so most of its failures are 429s. Compare the column
each drill is about: calls while down, lost or duplicate rows, budget overrun.

### Extraction on answers written blind
120 answers in German and English, with an answer key, were written by an agent that read only
[heldout/WRITING_ANSWERS.md](heldout/WRITING_ANSWERS.md), never the code. They cover brands that are
ordinary words ("Pilot", "Signal") used in both senses, names only in tables or URLs, possessives,
German inflection, and the same page cited in different forms. First run, kept as written:
[reports/heldout/v1/FIRST_RUN.md](reports/heldout/v1/FIRST_RUN.md).

| | Precision | Recall |
|---|---|---|
| Brand mentions (337 in the key) | **100.0%** | **98.5%** |
| Order of first mention | 99.0% exact | |
| Cited pages (232 in the key) | 98.3% | 98.3% |

All 4 page errors are AMP URLs. The writing guide did not say whether `/amp` is the same page; the
writer kept it, and this code treats it as the same page. The 5 missed mentions are in the report.
On the simulator's own answers, which are harder on purpose (ambiguous names opening sentences),
mention recall is 93.9%.

### What the drills found
Each of these was a real bug, found by a drill, and is written up with before-and-after numbers:
- [Runs paid for twice when a lease expired during rate-limit waits](docs/postmortems/2026-10-24-lease-expiry-double-spend.md):
  17% extra spend on one provider, invisible in the data.
- [The shared rate limiter let through six times its rate](docs/postmortems/2026-10-24-rate-limiter-truncated-waits.md):
  Redis truncates Lua numbers, so a 0.4 ms wait read as "go".
- [A provider lowered its limit and the backlog took twice as long](docs/postmortems/2026-10-24-provider-lowered-limit.md):
  pausing is not slowing down; fixed with an adaptive (AIMD) shared rate.
- [Under crashes and a queue loss, runs never finished and the ledger under-counted](docs/postmortems/2026-10-24-crash-drill-stuck-runs.md):
  orphaned queue ids, crash recovery spending the retry budget, and a ledger written after the call.

## How it works

```
 scheduler ──plan slot (idempotent ids)──▶ Postgres (record) ◀──reconcile: queued in PG, lost in Redis
     │ feed up to high-water mark                    ▲
     ▼                                               │ fenced: result + analytics outbox + event outbox
 Redis lease queue ──lease + fence + heartbeat──▶ workers ──▶ providers
     shared per provider: circuit · retry budget · GCRA rate (AIMD) · semaphore · cost reservation
 analytics outbox ──shipper (dedup token)──▶ ClickHouse ReplacingMergeTree, read FINAL ──▶ API
 event outbox ──fan-out──▶ signed webhooks (Standard Webhooks), retried, auto-disable
```

- **Postgres is the record, Redis is work in flight** ([ADR 0001](docs/adr/0001-postgres-is-the-record.md)).
  If Redis loses the queue, the scheduler re-queues from Postgres.
- **Fencing tokens**: every lease gets a strictly increasing number. Writes and acks apply only
  under the current one, so a worker that stalled past its lease cannot complete work that was handed on.
- **A lease queue on Redis instead of Pub/Sub, Cloud Tasks or RabbitMQ** ([ADR 0002](docs/adr/0002-queue-on-redis-not-pubsub.md)):
  per-message delays, deferral without spending an attempt, fencing, and idempotent enqueue.
- **Limits are shared, not per process** ([ADR 0003](docs/adr/0003-limits-shared-not-per-worker.md)):
  - GCRA at 90% of each provider's limit; a 429 pauses every worker and lowers the shared rate.
  - A circuit breaker that defers runs instead of failing them.
  - A retry budget so outages are not amplified.
  - A cost reservation before every call.
- **Write-ahead cost ledger**: a call is recorded before it is made, so the ledger can only
  over-count, never under-count, the invoice.
- **Schema drift is kept, not retried** ([ADR 0004](docs/adr/0004-schema-drift-is-not-retried.md)),
  and recovered by `src/cmd/reparse.ts` after the parser fix.
- **Customer-safe status**: `/v1/projects/:id/runs` explains missing data in plain words ("Delayed:
  the AI provider changed its answer format… no action needed"). Provider internals stay in logs.

More: [ARCHITECTURE](docs/ARCHITECTURE.md) · [RUNBOOK](docs/RUNBOOK.md) (one section per alert) ·
alerts in [deploy/prometheus/alerts.yml](deploy/prometheus/alerts.yml) · Grafana dashboard in
[deploy/grafana](deploy/grafana) · [Kubernetes](deploy/k8s/base.yaml).

## API

| Endpoint | |
|---|---|
| `POST /v1/projects` · `PUT /v1/projects/:id/brands` · `PUT /v1/projects/:id/prompts` | what a customer tracks |
| `GET /v1/projects/:id/visibility?from&to[&provider]` | per brand: visibility, average position, share of voice; per provider |
| `GET /v1/projects/:id/sources?from&to` | cited domains with source type (own, competitor, review, UGC, editorial, reference) |
| `GET /v1/projects/:id/runs?from&to` | run counts and customer-safe explanations of what is missing |
| `POST /v1/projects/:id/webhooks` | register an endpoint; the signing secret is returned once |
| `GET /v1/ops/providers` | circuit, pause, in-flight and effective rate per provider |
| `GET /healthz` · `/readyz` · `/metrics` | |

API keys are scoped to projects (`API_KEYS="admin:*,key1:p001|p002"`).

## Run it

```bash
bun install
docker compose up -d --build                       # Postgres, Redis, ClickHouse, API, workers, scheduler, shipper, simulator, Prometheus, Grafana
docker compose run --rm migrate && docker compose run --rm seed
curl localhost:3000/v1/ops/providers
```

Tests and drills need Postgres, Redis and ClickHouse (`DATABASE_URL`, `REDIS_URL`, `CLICKHOUSE_URL`):

```bash
bun test --timeout 60000                           # 53 tests: unit, queue and limits against Redis, the full pipeline, the API
bun run src/cmd/drill.ts && bun run src/cmd/gate.ts
bun run src/cmd/heldout.ts v1                      # extraction on the blind answers (first run is kept)
```

Without Docker, `scripts/chdb_http.py` serves ClickHouse's HTTP interface from chDB (the embedded
ClickHouse engine). That is how this repository was developed. CI uses the real
`clickhouse-server` image.

## Limits

- **The providers are simulated.** Response shapes follow each provider's public API, but limits,
  outages and costs are scenario settings. Real providers count limits per minute and per
  organisation, which the 90% headroom only partly covers.
- **Times are compressed.** Drills use 2 s leases and sub-second backoffs. Production settings
  are in `config/`.
- **Scraping is out of scope.** AI Overview answers come through a SERP-provider API. Browser
  automation, proxies and CAPTCHA handling are not here.
- **Not built:** sentiment scoring, prompt suggestions, multi-region ClickHouse, and an exchange of
  the Redis queue for Pub/Sub. ADR 0002 says how the last would be done.
- **Who wrote the tests:** the simulator's answers and their key were written by the author of
  the extraction code. The held-out set was not, and it is small (120 answers).

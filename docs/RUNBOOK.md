# Runbook

Every alert in `deploy/prometheus/alerts.yml` links here. First look:
`GET /v1/ops/providers` (circuit state, pause, in-flight, effective rate per provider) and the
Grafana dashboard "AI visibility data plane".

## Provider outage
*Alert: RunsFailingForProvider.*
1. Dashboard: is the provider's circuit open? Are retries being deferred by the retry budget? Both
   are the system protecting the provider. Runs are deferred, not failed, while the circuit is open.
2. Check the provider's status page. If the outage is long, nothing needs doing: runs older than
   `limits.queue.max_age_ms` are reported as `expired`, and customers see "will be collected in the
   next scheduled run".
3. Do **not** raise retry limits during an outage. That multiplies load on the provider when it
   comes back.

## Throttled
*Alert: ThrottledByProvider.* The provider is answering 429 although the shared limiter keeps to
`config/providers.yaml`.
1. `GET /v1/ops/providers`: `rate_per_second.effective` below `configured` means the limiter has
   already adapted (AIMD) and the system is running at the provider's real limit.
2. Find out why the limit changed (account tier, a new key sharing the org pool, a published change).
3. Update `rate.per_second` to 90% of the new limit by pull request. Until then the adaptive rate
   holds, at the cost of a sawtooth of 429s.

## Schema drift
*Alert: ProviderSchemaDrift.* A provider changed its response format. Affected runs fail with
`schema_drift`, and their bodies are in the `quarantine` table. They are not retried, so no
money is spent twice.
1. `SELECT reason, sample FROM quarantine WHERE resolved_at IS NULL AND provider = '…' LIMIT 3;`
   The reason shows the new shape.
2. Add a parser for the shape in `src/providers/parsers.ts`, with a test built from a quarantined
   sample. Deploy.
3. `bun run src/cmd/reparse.ts` completes the runs from the stored bodies. Check the quarantine
   is empty.

## Analytics not arriving
*Alert: AnalyticsNotArriving.* Runs complete but ClickHouse does not get them.
1. `SELECT count(*) FROM analytics_outbox WHERE shipped_at IS NULL;` A growing number means the
   shipper is down or ClickHouse is refusing inserts (check the shipper's logs for `clickhouse 4xx/5xx`).
2. Nothing is lost while this lasts: the outbox is in Postgres. When the shipper recovers it
   catches up, and the deduplication token plus ReplacingMergeTree make re-sent batches harmless.

## Backlog
*Alert: QueueBacklogGrowing.* More runs are scheduled than providers allow.
1. Is a provider's effective rate low (throttled), or its circuit open? Then see above.
2. Otherwise this is capacity: workers scale on queue depth (KEDA), but provider limits cap
   throughput. A day of 1M runs over five providers needs about 2.3 runs per second each on average.
   Raise the negotiated limits or spread prompts over the day (prompt `interval_minutes`, slots).

## Dead letters
*Alert: DeadLetters.* Runs exhausted their attempts (`exhausted`), or a provider failed them
past `retry.max_attempts`.
`SELECT provider, error_kind, count(*) FROM run WHERE status = 'failed' AND finished_at > now() - interval '1 hour' GROUP BY 1, 2;`
Repeated `exhausted` on one provider with healthy calls means workers are dying mid-run: check
pod restarts and OOM kills.

## Spend
*Alert: SpendAboveForecast.*
`SELECT provider, outcome, count(*), sum(cost_eur) FROM provider_call WHERE at > now() - interval '1 hour' GROUP BY 1, 2;`
Many `started` rows (calls whose worker died) or many paid failures (`truncated`, 5xx at
providers that bill failures) explain most spikes. Successful calls per run above 1 point to
lease problems (see `docs/postmortems/2026-10-24-lease-expiry-double-spend.md`).

## Reconciling the ledger with an invoice
The ledger records every call before it is made (`outcome = 'started'`) at its expected cost, and
updates it with the result. It is meant to be at or slightly above the provider's invoice:
calls that died before reaching the provider are counted, and calls billed but never recorded
are not possible. A ledger below the invoice is a bug.

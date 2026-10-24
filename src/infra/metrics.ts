// Prometheus metrics. Names follow the RED method per provider and USE for the queue.
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "avd_" });

const c = (name: string, help: string, labelNames: string[] = []) => new client.Counter({ name, help, labelNames, registers: [registry] });
const g = (name: string, help: string, labelNames: string[] = []) => new client.Gauge({ name, help, labelNames, registers: [registry] });
const h = (name: string, help: string, labelNames: string[], buckets: number[]) =>
  new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });

export const m = {
  providerRequests: c("avd_provider_requests_total", "Calls to AI providers by outcome", ["provider", "outcome"]),
  providerLatency: h("avd_provider_latency_seconds", "Provider call latency", ["provider"], [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]),
  providerCost: c("avd_provider_cost_eur_total", "Money spent on provider calls", ["provider"]),
  effectiveRate: g("avd_provider_effective_rate", "Requests per second the shared limiter currently allows", ["provider"]),
  rateLimitWait: c("avd_rate_limit_wait_seconds_total", "Time workers waited for a rate-limit token", ["provider"]),
  circuitState: g("avd_circuit_open", "1 while a provider's circuit is open", ["provider"]),
  retriesDeferred: c("avd_retries_deferred_total", "Retries pushed back because the retry budget was spent", ["provider"]),
  runs: c("avd_runs_total", "Runs reaching a terminal state", ["provider", "status"]),
  runDuration: h("avd_run_seconds", "Scheduled slot to analytics-visible", ["provider"], [0.5, 1, 2, 5, 10, 30, 60, 300, 900]),
  queueDepth: g("avd_queue_depth", "Runs by queue state", ["state"]),
  queueStale: c("avd_queue_stale_acks_total", "Acks rejected because the lease had moved to another worker"),
  leasesExpired: c("avd_queue_leases_expired_total", "Leases that expired and were handed back"),
  deadLettered: c("avd_dead_lettered_total", "Runs moved to the dead-letter queue", ["provider", "reason"]),
  schemaDrift: c("avd_provider_schema_drift_total", "Responses whose shape no parser accepts", ["provider"]),
  budgetRejected: c("avd_budget_rejected_total", "Runs not started because the project's daily budget was reached"),
  scheduleDeferred: c("avd_schedule_deferred_total", "Runs left pending because the queue was above its high-water mark"),
  analyticsRows: c("avd_analytics_rows_total", "Rows written to ClickHouse", ["table"]),
  analyticsLag: g("avd_analytics_outbox_pending", "Completed runs not yet in ClickHouse"),
  webhookDeliveries: c("avd_webhook_deliveries_total", "Webhook delivery attempts by outcome", ["outcome"]),
  httpRequests: c("avd_http_requests_total", "API requests", ["route", "status"]),
};

// The worker: lease runs, call the provider within every limit, and record the outcome exactly once.
//
// Order of checks for each run, cheapest and most protective first:
//   attempts left? -> provider circuit closed? -> retry budget (for retries) -> rate-limit token ->
//   concurrency slot -> cost reservation -> call -> settle cost -> fenced write -> ack.
// A run that cannot go now is deferred with a delay and keeps its place; only real tries count as
// attempts. Nothing is dropped: every run ends succeeded, failed (with a kind), or skipped for budget.
import type { SQL } from "bun";
import type Redis from "ioredis";
import { type ProviderConfig, settings } from "../infra/config";
import { log } from "../infra/log";
import { m } from "../infra/metrics";
import { span } from "../infra/tracing";
import { CostBudget } from "../limits/budget";
import { CircuitBreaker } from "../limits/circuit";
import { Semaphore } from "../limits/concurrency";
import { RateLimiter } from "../limits/rate";
import { RetryBudget } from "../limits/retry-budget";
import { callProvider } from "../providers/client";
import { ProviderError } from "../providers/types";
import { backoffMs } from "../queue/backoff";
import { type Lease, Queue } from "../queue/queue";
import { toAnalytics } from "./extract";
import { dayOf } from "./ids";
import { RunStore } from "./store";
import type { RunJob } from "./types";

export const RUN_QUEUE = "runs";

export interface WorkerOptions {
  providerBaseUrl: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  /** Drills only: exit the process right after a provider call, before anything is recorded. */
  crashAfterCallRate?: number;
}

export class Worker {
  readonly queue: Queue<RunJob>;
  private readonly store: RunStore;
  private readonly rate: RateLimiter;
  private readonly sem: Semaphore;
  private readonly circuit: CircuitBreaker;
  private readonly retryBudget: RetryBudget;
  private readonly budget: CostBudget;
  private running = false;
  private inFlight = 0;
  readonly stats = { processed: 0, staleWrites: 0, deferred: 0 };

  constructor(
    r: Redis,
    sql: SQL,
    private readonly opts: WorkerOptions,
  ) {
    const L = settings().limits;
    this.queue = new Queue<RunJob>(r, RUN_QUEUE, L.queue.lease_ms);
    this.store = new RunStore(sql);
    this.rate = new RateLimiter(r);
    this.sem = new Semaphore(r);
    this.circuit = new CircuitBreaker(r);
    this.retryBudget = new RetryBudget(r);
    this.budget = new CostBudget(r);
  }

  async start(): Promise<void> {
    this.running = true;
    const max = this.opts.concurrency ?? settings().limits.worker.concurrency;
    while (this.running) {
      const free = max - this.inFlight;
      if (free <= 0) {
        await Bun.sleep(5);
        continue;
      }
      await this.queue.reap();
      const leases = await this.queue.lease(Math.min(free, 32));
      if (!leases.length) {
        await Bun.sleep(20);
        continue;
      }
      for (const l of leases) {
        this.inFlight++;
        this.process(l)
          .catch((e) => log.error("run crashed", { run_id: l.id, err: String(e) }))
          .finally(() => {
            this.inFlight--;
          });
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    while (this.inFlight > 0) await Bun.sleep(10);
  }

  private async defer(l: Lease<RunJob>, ms: number, reason: string) {
    this.stats.deferred++;
    await this.queue.retry(l, Date.now() + ms + Math.floor(Math.random() * 25), false);
    log.debug("deferred", { run_id: l.id, reason, ms });
  }

  /** Keep the lease alive for the whole time this worker holds the run, and notice if it is lost. */
  private keepLease(l: Lease<RunJob>) {
    const k = { lost: false, timer: undefined as ReturnType<typeof setInterval> | undefined };
    k.timer = setInterval(
      () => {
        void this.queue.heartbeat(l).then((ok) => {
          if (!ok) k.lost = true;
        });
      },
      Math.max(100, settings().limits.queue.lease_ms / 4),
    );
    return {
      get lost() {
        return k.lost;
      },
      stop: () => clearInterval(k.timer),
    };
  }

  async process(l: Lease<RunJob>): Promise<void> {
    const lease = this.keepLease(l);
    try {
      await this.processLeased(l, lease);
    } finally {
      lease.stop();
    }
  }

  private async processLeased(l: Lease<RunJob>, lease: { readonly lost: boolean }): Promise<void> {
    const job = l.payload;
    const cfg = settings().providers[job.provider];
    const L = settings().limits;
    if (!cfg) {
      await this.finish(l, () => this.store.fail(job, l.fence, "rejected", `unknown provider ${job.provider}`), "failed");
      return;
    }
    if (!(await this.store.claim(job.runId, l.fence, l.attempt))) {
      // a newer lease owns the run, or it is already finished: this lease is void
      await this.queue.ack(l);
      return;
    }
    if (Date.now() - job.queuedAt > L.queue.max_age_ms) {
      await this.finish(l, () => this.store.fail(job, l.fence, "expired", `not collected within ${L.queue.max_age_ms} ms`), "failed", true);
      return;
    }
    if (l.attempt > L.queue.max_attempts) {
      await this.finish(l, () => this.store.fail(job, l.fence, "exhausted", `gave up after ${l.attempt - 1} attempts`), "failed", true);
      return;
    }
    const wait = await this.circuit.allow(job.provider, cfg.circuit);
    if (wait > 0) return this.defer(l, wait, "circuit_open");
    const isRetry = l.attempt > 1;
    if (!(await this.retryBudget.spend(job.provider, isRetry, cfg.retry_budget.ratio, cfg.retry_budget.min_per_second))) {
      m.retriesDeferred.inc({ provider: job.provider });
      return this.defer(l, 500 + backoffMs(l.attempt, cfg.retry.base_ms, cfg.retry.cap_ms), "retry_budget");
    }
    // rate limit: wait briefly inline, otherwise give the slot back and come back later
    let w = await this.rate.acquire(job.provider, cfg.rate.per_second, cfg.rate.burst);
    let waited = 0;
    while (w > 0) {
      // waiting inline is cheap for short waits; a long or repeated wait gives the slot back instead
      if (w > L.worker.max_inline_wait_ms || waited + w > 2 * L.worker.max_inline_wait_ms) return this.defer(l, w, "rate_limit");
      m.rateLimitWait.inc({ provider: job.provider }, w / 1000);
      await Bun.sleep(w);
      waited += w;
      w = await this.rate.acquire(job.provider, cfg.rate.per_second, cfg.rate.burst);
    }
    const holder = `${job.runId}:${l.fence}`;
    if (!(await this.sem.acquire(job.provider, cfg.concurrency, holder, cfg.timeout_ms + 2000))) return this.defer(l, 30, "concurrency");
    const day = dayOf(new Date(job.slot));
    try {
      const project = await this.store.project(job.projectId);
      if (!(await this.budget.reserve(job.projectId, day, cfg.cost_eur, project.dailyBudgetEur, holder, L.budget.reservation_ttl_ms))) {
        m.budgetRejected.inc();
        await this.finish(
          l,
          () => this.store.fail(job, l.fence, "budget", `daily budget of €${project.dailyBudgetEur} reached`, "skipped_budget"),
          "skipped_budget",
        );
        return;
      }
      if (lease.lost) {
        // the lease expired while we waited; another worker has the run, so do not pay for it twice
        await this.budget.settle(job.projectId, day, holder, 0);
        m.queueStale.inc();
        return;
      }
      await this.call(l, job, cfg, project, holder, day);
    } finally {
      await this.sem.release(job.provider, holder);
    }
  }

  private async call(
    l: Lease<RunJob>,
    job: RunJob,
    cfg: ProviderConfig,
    project: Awaited<ReturnType<RunStore["project"]>>,
    holder: string,
    day: string,
  ) {
    const t0 = performance.now();
    try {
      const { answer, raw } = await span("provider.call", { provider: job.provider, run_id: job.runId, attempt: l.attempt }, () =>
        callProvider(
          this.opts.providerBaseUrl,
          cfg,
          { runId: job.runId, promptId: job.promptId, prompt: job.prompt, country: job.country },
          this.opts.fetchImpl,
        ),
      );
      const ms = performance.now() - t0;
      if (this.opts.crashAfterCallRate && Math.random() < this.opts.crashAfterCallRate) process.exit(137); // drill: the worst moment to die
      m.providerLatency.observe({ provider: job.provider }, ms / 1000);
      m.providerRequests.inc({ provider: job.provider, outcome: "ok" });
      m.effectiveRate.set({ provider: job.provider }, await this.rate.succeeded(job.provider, cfg.rate.per_second));
      await this.budget.settle(job.projectId, day, holder, cfg.cost_eur);
      m.providerCost.inc({ provider: job.provider }, cfg.cost_eur);
      m.circuitState.set({ provider: job.provider }, (await this.circuit.record(job.provider, true, cfg.circuit)) === "open" ? 1 : 0);
      await this.store.recordCall(job.runId, job.provider, l.attempt, "ok", 200, Math.round(ms), cfg.cost_eur);
      const analytics = await toAnalytics(job, project, answer, this.opts.fetchImpl);
      const wrote = await this.store.complete(
        job,
        l.fence,
        { model: answer.model, requestId: answer.requestId, text: answer.text, raw: JSON.parse(raw), parser: answer.parser },
        analytics,
      );
      if (!wrote) {
        this.stats.staleWrites++;
        m.queueStale.inc();
      }
      if (!(await this.queue.ack(l))) m.queueStale.inc();
      m.runs.inc({ provider: job.provider, status: "succeeded" });
      this.stats.processed++;
    } catch (e) {
      const ms = performance.now() - t0;
      if (!(e instanceof ProviderError)) throw e;
      // a 200 that we could not use is billed; a 5xx is billed only by providers that bill failures
      // a call we abandoned on timeout may well have been processed and billed: count it, so the
      // ledger and the budget never under-count (drill "steady" found this gap against the provider)
      const billed = e.timedOut || (e.status !== null && (e.status < 300 || (e.status >= 500 && !!cfg.bills_failed_calls)));
      const cost = billed ? cfg.cost_eur : 0;
      await this.budget.settle(job.projectId, day, holder, cost);
      if (cost) m.providerCost.inc({ provider: job.provider }, cost);
      m.providerRequests.inc({ provider: job.provider, outcome: e.kind });
      await this.store.recordCall(job.runId, job.provider, l.attempt, e.kind, e.status, Math.round(ms), cost);
      await this.onError(l, job, cfg, e);
    }
  }

  private async onError(l: Lease<RunJob>, job: RunJob, cfg: ProviderConfig, e: ProviderError) {
    switch (e.kind) {
      case "throttled": {
        // the provider's limit is lower than we thought: everyone pauses, this run retries after it
        const pause = e.retryAfterMs ?? 1000;
        await this.rate.pause(job.provider, Date.now() + pause);
        m.effectiveRate.set({ provider: job.provider }, await this.rate.throttled(job.provider, cfg.rate.per_second));
        log.warn("provider throttled us", { provider: job.provider, retry_after_ms: pause });
        await this.queue.retry(l, Date.now() + pause + Math.floor(Math.random() * 200));
        return;
      }
      case "unavailable":
      case "truncated": {
        m.circuitState.set({ provider: job.provider }, (await this.circuit.record(job.provider, false, cfg.circuit)) === "open" ? 1 : 0);
        if (l.attempt >= cfg.retry.max_attempts) {
          await this.finish(l, () => this.store.fail(job, l.fence, e.kind, e.message), "failed", true);
          return;
        }
        const delay = Math.max(e.retryAfterMs ?? 0, backoffMs(l.attempt, cfg.retry.base_ms, cfg.retry.cap_ms));
        await this.queue.retry(l, Date.now() + delay);
        return;
      }
      case "schema_drift": {
        // retrying cannot help and costs money; keep the body so a parser fix can complete the run
        m.schemaDrift.inc({ provider: job.provider });
        log.error("provider response shape changed", { provider: job.provider, run_id: job.runId, detail: e.message });
        await this.store.quarantine(job.runId, job.provider, e.message, e.raw ?? "");
        await this.finish(l, () => this.store.fail(job, l.fence, "schema_drift", e.message), "failed");
        return;
      }
      default:
        await this.finish(l, () => this.store.fail(job, l.fence, e.kind, e.message), "failed");
    }
  }

  private async finish(l: Lease<RunJob>, write: () => Promise<boolean>, status: string, dead = false) {
    if (!(await write())) this.stats.staleWrites++;
    if (dead) {
      await this.queue.dead(l);
      m.deadLettered.inc({ provider: l.payload.provider, reason: status });
    } else await this.queue.ack(l);
    m.runs.inc({ provider: l.payload.provider, status });
    this.stats.processed++;
  }
}

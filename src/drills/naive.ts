// The baseline the drills compare against: the worker most teams write first. A Redis list as the
// queue, a fixed retry loop that ignores Retry-After, no shared rate limiter or circuit breaker,
// a budget checked before the call and charged after it, a direct ClickHouse insert retried on
// error, and no leases: a worker that dies holding a job loses it. Same simulator, same world,
// same concurrency, same faults.
import type Redis from "ioredis";
import type { ClickHouse } from "../infra/clickhouse";
import { settings } from "../infra/config";
import { callProvider } from "../providers/client";
import { ProviderError } from "../providers/types";
import type { ProviderSim } from "../sim/provider-sim";
import type { SimProject } from "../sim/world";

export interface NaiveResult {
  runs: number;
  stored_runs: number;
  lost: number;
  duplicate_rows: number;
  failed: number;
  skipped_budget: number;
  providers: Record<string, { requests: number; per_run: number; over_limit_429: number; during_outage: number }>;
  max_budget_overrun_eur: number;
  projects_over_budget: number;
  seconds: number;
}

export async function runNaive(
  r: Redis,
  ch: ClickHouse,
  sim: ProviderSim,
  world: SimProject[],
  opts: {
    concurrency: number;
    budgets: Map<string, number>;
    crashAfterCallRate?: number;
    insertRetryDuplicateRate?: number;
    timeoutMs: number;
  },
): Promise<NaiveResult> {
  await ch.command(
    "CREATE TABLE IF NOT EXISTS naive_answers (run_id String, project_id String, provider String) ENGINE = MergeTree ORDER BY run_id",
  );
  await ch.command("TRUNCATE TABLE naive_answers");
  await r.del("naive:q");
  const providers = Object.keys(settings().providers);
  const jobs = world.flatMap((p) =>
    p.prompts.flatMap((q) =>
      providers.map((prov) => ({
        runId: `naive-${q.id}-${prov}`,
        project: p.id,
        promptId: q.id,
        prompt: q.text,
        country: q.country,
        provider: prov,
      })),
    ),
  );
  for (let i = 0; i < jobs.length; i += 500) await r.lpush("naive:q", ...jobs.slice(i, i + 500).map((j) => JSON.stringify(j)));
  const spent = new Map<string, number>();
  let failed = 0;
  let skipped = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (Date.now() - t0 < opts.timeoutMs) {
      const raw = await r.rpop("naive:q");
      if (!raw) return;
      const j = JSON.parse(raw) as (typeof jobs)[number];
      const cfg = settings().providers[j.provider]!;
      // check, then spend: concurrent workers all pass the check before any of them has paid
      if ((spent.get(j.project) ?? 0) >= opts.budgets.get(j.project)!) {
        skipped++;
        continue;
      }
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          await Bun.sleep(0);
          await callProvider(sim.url, cfg, { runId: j.runId, promptId: j.promptId, prompt: j.prompt, country: j.country });
          ok = true;
          spent.set(j.project, (spent.get(j.project) ?? 0) + cfg.cost_eur);
        } catch (e) {
          if (e instanceof ProviderError && e.status !== null && e.status < 300)
            spent.set(j.project, (spent.get(j.project) ?? 0) + cfg.cost_eur);
          await Bun.sleep(200);
        }
      }
      if (!ok) {
        failed++;
        continue;
      }
      if (opts.crashAfterCallRate && Math.random() < opts.crashAfterCallRate) continue; // died holding the job: it is gone
      await ch.insert("naive_answers", [{ run_id: j.runId, project_id: j.project, provider: j.provider }]);
      // the insert landed but the client saw a timeout, so it inserted again
      if (opts.insertRetryDuplicateRate && Math.random() < opts.insertRetryDuplicateRate)
        await ch.insert("naive_answers", [{ run_id: j.runId, project_id: j.project, provider: j.provider }]);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const [c] = await ch.query<{ rows: string; runs: string }>("SELECT count() AS rows, uniqExact(run_id) AS runs FROM naive_answers");
  const stats = sim.stats();
  const out: NaiveResult["providers"] = {};
  const perProvider = jobs.length / providers.length;
  for (const [p, s] of Object.entries(stats))
    out[p] = {
      requests: s.requests,
      per_run: Math.round((s.requests / perProvider) * 10_000) / 10_000,
      over_limit_429: s.overLimit,
      during_outage: s.inOutage,
    };
  let maxOver = 0;
  let over = 0;
  for (const [p, eur] of spent) {
    const o = eur - opts.budgets.get(p)!;
    if (o > 1e-9) {
      over++;
      maxOver = Math.max(maxOver, o);
    }
  }
  const stored = Number(c?.runs ?? 0);
  return {
    runs: jobs.length,
    stored_runs: stored,
    lost: jobs.length - stored - failed - skipped,
    duplicate_rows: Number(c?.rows ?? 0) - stored,
    failed,
    skipped_budget: skipped,
    providers: out,
    max_budget_overrun_eur: Math.round(maxOver * 10_000) / 10_000,
    projects_over_budget: over,
    seconds: (Date.now() - t0) / 1000,
  };
}

// Runs one drill: a simulated world, the provider simulator with the drill's faults, worker
// processes (restarted when they die, as Kubernetes would), and the scheduler, analytics shipper and
// webhook deliverer. It waits until every run has reached a terminal state and every outbox is
// drained, then measures.
import type { SQL } from "bun";
import type Redis from "ioredis";
import type { ClickHouse } from "../infra/clickhouse";
import { overrideSettings, ROOT, settings } from "../infra/config";
import { log } from "../infra/log";
import { reparseQuarantine } from "../runs/reparse";
import { Scheduler } from "../runs/scheduler";
import { AnalyticsShipper } from "../runs/shipper";
import { type ProviderFaults, ProviderSim } from "../sim/provider-sim";
import { makeWorld } from "../sim/world";
import { WebhookDeliverer } from "../webhooks/webhooks";
import { type Measures, measure } from "./measure";
import { resetStores, seedWorld } from "./seed";

export interface DrillSpec {
  name: string;
  title: string;
  question: string;
  projects: number;
  promptsPerProject: number;
  faults: Record<string, ProviderFaults>;
  workers: number;
  workerConcurrency: number;
  crashAfterCallRate?: number;
  shipperCrashRate?: number;
  /** Simulate the queue losing its contents (Redis failover without the latest writes) at this time. */
  dropQueueAtMs?: number;
  budgetEur?: (projectIndex: number) => number;
  disabledParsers?: string[];
  reparseAfter?: boolean;
  hookFailRate: number;
  settings?: Parameters<typeof overrideSettings>[0];
  timeoutMs: number;
}

export interface DrillResult {
  spec: Omit<DrillSpec, "budgetEur">;
  seconds: number;
  workerRestarts: number;
  timedOut: boolean;
  measures: Measures;
  reparse?: { resolved: number; still_unknown: number };
}

export async function runDrill(spec: DrillSpec, deps: { sql: SQL; r: Redis; ch: ClickHouse }): Promise<DrillResult> {
  const { sql, r, ch } = deps;
  if (spec.settings) overrideSettings(spec.settings);
  await resetStores(sql, r, ch);
  const world = makeWorld(spec.projects, spec.promptsPerProject, `world:${spec.name}`);
  const costs = Object.fromEntries(Object.entries(settings().providers).map(([k, v]) => [k, v.cost_eur]));
  const billFailures = Object.fromEntries(Object.entries(settings().providers).map(([k, v]) => [k, !!v.bills_failed_calls]));
  const faults = Object.fromEntries(Object.entries(spec.faults).map(([k, f]) => [k, { billFailures: billFailures[k], ...f }]));
  const sim = new ProviderSim({ seed: spec.name, providers: faults, costs }, world).listen();
  const budgets = new Map(world.map((p, i) => [p.id, spec.budgetEur?.(i) ?? 100]));
  await seedWorld(sql, world, {
    budgetEur: (_p, i) => budgets.get(world[i]!.id)!,
    hookUrl: (p) => sim.registerHook(p.id, spec.hookFailRate),
  });
  const expected = world.reduce((s, p) => s + p.prompts.length, 0) * Object.keys(settings().providers).length;

  let stopping = false;
  let restarts = 0;
  const procs = new Set<ReturnType<typeof Bun.spawn>>();
  const spawnWorker = () => {
    const p = Bun.spawn(["bun", `${ROOT}/src/cmd/worker.ts`], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROVIDER_BASE_URL: sim.url,
        WORKER_CONCURRENCY: String(spec.workerConcurrency),
        DRILL_CRASH_AFTER_CALL_RATE: String(spec.crashAfterCallRate ?? 0),
        DISABLED_PARSERS: (spec.disabledParsers ?? []).join(","),
        AVD_SETTINGS_OVERRIDE: JSON.stringify(spec.settings ?? {}),
        METRICS_PORT: "0",
        LOG_LEVEL: "error",
      },
      stdout: "ignore",
      stderr: "inherit",
      onExit: () => {
        procs.delete(p);
        if (!stopping) {
          restarts++;
          setTimeout(spawnWorker, 50); // the orchestrator restarts a dead pod
        }
      },
    });
    procs.add(p);
  };
  for (let i = 0; i < spec.workers; i++) spawnWorker();

  const scheduler = new Scheduler(r, sql);
  const shipper = new AnalyticsShipper(sql, ch);
  shipper.crashAfterInsertRate = spec.shipperCrashRate ?? 0;
  const hooks = new WebhookDeliverer(sql);
  const t0 = Date.now();
  sim.resetClock();
  const loops = [shipper.start(), hooks.start()];
  let dropped = false;
  let timedOut = false;
  let reparse: DrillResult["reparse"];
  const drained = async () => {
    const [x] = await sql`
      SELECT (SELECT count(*) FROM run WHERE status IN ('pending', 'queued'))::int AS open,
             (SELECT count(*) FROM analytics_outbox WHERE shipped_at IS NULL)::int AS unshipped,
             (SELECT count(*) FROM event_outbox WHERE fanned_out_at IS NULL)::int AS unfanned,
             (SELECT count(*) FROM webhook_delivery WHERE status = 'pending')::int AS undelivered,
             (SELECT count(*) FROM run)::int AS total`;
    return x.total > 0 && x.open === 0 && x.unshipped === 0 && x.unfanned === 0 && x.undelivered === 0;
  };
  while (true) {
    await scheduler.tick().catch((e) => log.error("tick", { err: String(e) }));
    if (spec.dropQueueAtMs !== undefined && !dropped && Date.now() - t0 >= spec.dropQueueAtMs) {
      dropped = true;
      const keys = await r.keys("q:{runs}:*");
      const lose = keys.filter((k) => k.includes(":job:") || k.endsWith(":ready"));
      if (lose.length) await r.del(...lose);
      log.warn("drill: dropped the queue", { keys: lose.length });
    }
    if (await drained()) {
      if (spec.reparseAfter && !reparse) {
        reparse = await reparseQuarantine(sql, r);
        continue;
      }
      break;
    }
    if (Date.now() - t0 > spec.timeoutMs) {
      timedOut = true;
      break;
    }
    await Bun.sleep(100);
  }
  const seconds = (Date.now() - t0) / 1000;
  stopping = true;
  for (const p of procs) p.kill();
  shipper.stop();
  hooks.stop();
  await Promise.all(loops);
  const measures = await measure(sql, ch, sim, expected, budgets);
  sim.stop();
  const { budgetEur: _b, ...rest } = spec;
  return { spec: rest, seconds, workerRestarts: restarts, timedOut, measures, ...(reparse ? { reparse } : {}) };
}

import type Redis from "ioredis";
import type { ClickHouse } from "../infra/clickhouse";
import { settings } from "../infra/config";
import { ProviderSim } from "../sim/provider-sim";
import { makeWorld } from "../sim/world";
import type { DrillSpec } from "./harness";
import { type NaiveResult, runNaive } from "./naive";

/** The same drill against the naive worker: same world, same faults, same total concurrency. */
export async function runBaselineFor(
  spec: DrillSpec & { baseline?: { crashAfterCallRate?: number; insertRetryDuplicateRate?: number } },
  deps: { r: Redis; ch: ClickHouse },
): Promise<NaiveResult> {
  const world = makeWorld(spec.projects, spec.promptsPerProject, `world:${spec.name}`);
  const costs = Object.fromEntries(Object.entries(settings().providers).map(([k, v]) => [k, v.cost_eur]));
  const billFailures = Object.fromEntries(Object.entries(settings().providers).map(([k, v]) => [k, !!v.bills_failed_calls]));
  const faults = Object.fromEntries(Object.entries(spec.faults).map(([k, f]) => [k, { billFailures: billFailures[k], ...f }]));
  const sim = new ProviderSim({ seed: `${spec.name}:baseline`, providers: faults, costs }, world).listen();
  const budgets = new Map(world.map((p, i) => [p.id, spec.budgetEur?.(i) ?? 100]));
  try {
    return await runNaive(deps.r, deps.ch, sim, world, {
      concurrency: spec.workers * spec.workerConcurrency,
      budgets,
      crashAfterCallRate: spec.baseline?.crashAfterCallRate,
      insertRetryDuplicateRate: spec.baseline?.insertRetryDuplicateRate,
      timeoutMs: spec.timeoutMs,
    });
  } finally {
    sim.stop();
  }
}

// What a drill measures, judged from the provider's ledger, the stores and the simulator's answer
// key, not from the data plane's own counters.
import type { SQL } from "bun";
import type { ClickHouse } from "../infra/clickhouse";
import type { ProviderSim } from "../sim/provider-sim";

export interface Measures {
  runs: { expected: number; succeeded: number; failed: Record<string, number>; skipped_budget: number; not_finished: number };
  analytics: {
    succeeded_not_in_clickhouse: number;
    customer_visible_duplicates: number;
    raw_rows_before_merge: number;
    distinct_runs: number;
  };
  providers: Record<string, { requests: number; per_run: number; over_limit_429: number; during_outage: number; ok: number }>;
  cost: { provider_billed_eur: number; ledger_eur: number; max_budget_overrun_eur: number; projects_over_budget: number };
  extraction: {
    mention_precision: number;
    mention_recall: number;
    position_exact: number;
    citation_precision: number;
    citation_recall: number;
    runs_scored: number;
  };
  freshness_s: { p50: number; p95: number; max: number };
  webhooks: {
    events: number;
    received_unique: number;
    missing: number;
    duplicate_deliveries: number;
    bad_signatures: number;
    failed_deliveries: number;
  };
  quarantine: { open: number; resolved: number };
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export async function measure(
  sql: SQL,
  ch: ClickHouse,
  sim: ProviderSim,
  expected: number,
  budgets: Map<string, number>,
): Promise<Measures> {
  const status = await sql`SELECT status, coalesce(error_kind, '') AS kind, count(*)::int AS n FROM run GROUP BY 1, 2`;
  const failed: Record<string, number> = {};
  let succeeded = 0;
  let skipped = 0;
  let notFinished = 0;
  for (const s of status) {
    if (s.status === "succeeded") succeeded += s.n;
    else if (s.status === "failed") failed[s.kind] = (failed[s.kind] ?? 0) + s.n;
    else if (s.status === "skipped_budget") skipped += s.n;
    else notFinished += s.n;
  }
  const total = status.reduce((a: number, s: { n: number }) => a + s.n, 0);
  notFinished += Math.max(0, expected - total);

  const [chCount] = await ch.query<{ rows: string; runs: string }>("SELECT count() AS rows, uniqExact(run_id) AS runs FROM answers FINAL");
  const [raw] = await ch.query<{ rows: string }>("SELECT count() AS rows FROM answers");
  const chRuns = new Set((await ch.query<{ run_id: string }>("SELECT DISTINCT run_id FROM answers FINAL")).map((x) => x.run_id));
  const okRuns = (await sql`SELECT id FROM run WHERE status = 'succeeded'`).map((x: { id: string }) => x.id);
  const missing = okRuns.filter((id: string) => !chRuns.has(id)).length;

  const simStats = sim.stats();
  const runsPer = await sql`SELECT provider, count(*)::int AS n FROM run GROUP BY provider`;
  const runsBy = new Map(runsPer.map((x: { provider: string; n: number }) => [x.provider, x.n]));
  const providers: Measures["providers"] = {};
  let billed = 0;
  for (const [p, s] of Object.entries(simStats)) {
    providers[p] = {
      requests: s.requests,
      per_run: r4(s.requests / Math.max(1, Number(runsBy.get(p) ?? 1))),
      over_limit_429: s.overLimit,
      during_outage: s.inOutage,
      ok: s.ok,
    };
    billed += s.costEur;
  }
  const [ledger] = await sql`SELECT coalesce(sum(cost_eur), 0)::float AS eur FROM provider_call`;
  const spentBy =
    await sql`SELECT r.project_id, sum(c.cost_eur)::float AS eur FROM provider_call c JOIN run r ON r.id = c.run_id GROUP BY 1`;
  let maxOver = 0;
  let over = 0;
  for (const s of spentBy) {
    const o = s.eur - (budgets.get(s.project_id) ?? Number.POSITIVE_INFINITY);
    if (o > 1e-9) {
      over++;
      maxOver = Math.max(maxOver, o);
    }
  }

  // extraction against the simulator's answer key
  const mentions = await ch.query<{ run_id: string; brand_id: string; mentioned: number; position: number }>(
    "SELECT run_id, brand_id, mentioned, position FROM mentions FINAL",
  );
  const cites = await ch.query<{ run_id: string; url: string }>("SELECT run_id, url FROM citations FINAL");
  const byRun = new Map<string, { m: Map<string, number>; c: Set<string> }>();
  for (const x of mentions) {
    const e = byRun.get(x.run_id) ?? { m: new Map(), c: new Set() };
    if (Number(x.mentioned) === 1) e.m.set(x.brand_id, Number(x.position));
    byRun.set(x.run_id, e);
  }
  for (const x of cites) byRun.get(x.run_id)?.c.add(x.url);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let posOk = 0;
  let ctp = 0;
  let cfp = 0;
  let cfn = 0;
  let scored = 0;
  for (const [runId, got] of byRun) {
    const truth = sim.truth.get(runId);
    if (!truth) continue;
    scored++;
    const truePos = new Map(truth.mentioned.map((b, i) => [b, i + 1]));
    for (const [b, pos] of got.m) {
      if (truePos.has(b)) {
        tp++;
        if (truePos.get(b) === pos) posOk++;
      } else fp++;
    }
    for (const b of truePos.keys()) if (!got.m.has(b)) fn++;
    const tc = new Set(truth.citations);
    for (const u of got.c) tc.has(u) ? ctp++ : cfp++;
    for (const u of tc) if (!got.c.has(u)) cfn++;
  }

  const fresh = (
    await sql`SELECT extract(epoch FROM o.shipped_at - r.created_at)::float AS s FROM analytics_outbox o JOIN run r ON r.id = o.run_id WHERE o.shipped_at IS NOT NULL`
  ).map((x: { s: number }) => x.s);

  const [ev] =
    await sql`SELECT count(*)::int AS n FROM event_outbox e WHERE EXISTS (SELECT 1 FROM webhook_endpoint w WHERE w.project_id = e.project_id AND e.type = ANY(w.event_types))`;
  const [fd] = await sql`SELECT count(*)::int AS n FROM webhook_delivery WHERE status = 'failed'`;
  let unique = 0;
  let dupes = 0;
  let bad = 0;
  for (const h of sim.hooks.values()) {
    unique += h.received.size;
    for (const c of h.received.values()) dupes += c - 1;
    bad += h.badSignatures;
  }
  const [qo] =
    await sql`SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open, count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved FROM quarantine`;

  return {
    runs: { expected, succeeded, failed, skipped_budget: skipped, not_finished: notFinished },
    analytics: {
      succeeded_not_in_clickhouse: missing,
      customer_visible_duplicates: Number(chCount?.rows ?? 0) - Number(chCount?.runs ?? 0),
      raw_rows_before_merge: Number(raw?.rows ?? 0),
      distinct_runs: Number(chCount?.runs ?? 0),
    },
    providers,
    cost: {
      provider_billed_eur: r4(billed),
      ledger_eur: r4(ledger?.eur ?? 0),
      max_budget_overrun_eur: r4(maxOver),
      projects_over_budget: over,
    },
    extraction: {
      mention_precision: r4(tp / Math.max(1, tp + fp)),
      mention_recall: r4(tp / Math.max(1, tp + fn)),
      position_exact: r4(posOk / Math.max(1, tp)),
      citation_precision: r4(ctp / Math.max(1, ctp + cfp)),
      citation_recall: r4(ctp / Math.max(1, ctp + cfn)),
      runs_scored: scored,
    },
    freshness_s: { p50: r4(q(fresh, 0.5)), p95: r4(q(fresh, 0.95)), max: r4(q(fresh, 1)) },
    webhooks: {
      events: ev?.n ?? 0,
      received_unique: unique,
      missing: Math.max(0, (ev?.n ?? 0) - unique),
      duplicate_deliveries: dupes,
      bad_signatures: bad,
      failed_deliveries: fd?.n ?? 0,
    },
    quarantine: { open: qo?.open ?? 0, resolved: qo?.resolved ?? 0 },
  };
}

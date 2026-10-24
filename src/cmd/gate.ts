// The release gate over the drill reports: invariants that must hold under every injected fault.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DrillResult } from "../drills/harness";
import { ROOT } from "../infra/config";

const dir = join(ROOT, "reports", "drills");
const failures: string[] = [];
let checked = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as DrillResult;
  const m = r.measures;
  const name = r.spec.name;
  const check = (ok: boolean, what: string) => {
    checked++;
    if (!ok) failures.push(`${name}: ${what}`);
  };
  check(!r.timedOut, "finished before the timeout");
  check(m.runs.not_finished === 0, `every run reached a terminal state (${m.runs.not_finished} did not)`);
  check(m.analytics.customer_visible_duplicates === 0, `no duplicates visible to customers (${m.analytics.customer_visible_duplicates})`);
  check(
    m.analytics.succeeded_not_in_clickhouse === 0,
    `every collected run is in ClickHouse (${m.analytics.succeeded_not_in_clickhouse} missing)`,
  );
  check(m.cost.projects_over_budget === 0, `no project over its daily budget (${m.cost.projects_over_budget})`);
  check(
    m.cost.ledger_eur + 1e-6 >= m.cost.provider_billed_eur,
    `the cost ledger never under-counts the provider's bill (${m.cost.ledger_eur} < ${m.cost.provider_billed_eur})`,
  );
  check(m.webhooks.missing === 0, `every event delivered (${m.webhooks.missing} missing)`);
  check(m.webhooks.bad_signatures === 0, "every webhook correctly signed");
  for (const [p, s] of Object.entries(m.providers)) check(s.ok <= Math.round(s.requests), `${p}: never more successful calls than calls`);
  if (name === "steady") {
    check(m.extraction.mention_precision >= 0.98, `mention precision >= 98% (${m.extraction.mention_precision})`);
    check(m.extraction.mention_recall >= 0.9, `mention recall >= 90% (${m.extraction.mention_recall})`);
    check(m.extraction.citation_recall >= 0.98, `citation recall >= 98% (${m.extraction.citation_recall})`);
    check(
      Object.values(m.providers).every((p) => p.over_limit_429 === 0),
      "no self-inflicted 429s on a normal day",
    );
  }
  if (name === "drift") check(m.quarantine.open === 0, `every drifted answer recovered (${m.quarantine.open} open)`);
}
console.log(`gate: ${checked} checks, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);

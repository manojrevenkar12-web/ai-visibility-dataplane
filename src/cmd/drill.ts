// bun run drill [name ...] — run drills, compare with the naive baseline, write reports/drills/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRILLS, markdown, runBaselineFor, runDrill } from "../drills/index";
import { clickhouse } from "../infra/clickhouse";
import { ROOT } from "../infra/config";
import { closePg, pg } from "../infra/pg";
import { closeRedis, redis } from "../infra/redis";

const names = process.argv.slice(2);
const sql = pg();
const r = redis();
const ch = clickhouse();
const out = join(ROOT, "reports", "drills");
mkdirSync(out, { recursive: true });
const results = [];
for (const d of DRILLS.filter((x) => !names.length || names.includes(x.name))) {
  console.log(`[drill] ${d.name}: ${d.title}`);
  const res = await runDrill(d, { sql, r, ch });
  const baseline = d.baseline ? await runBaselineFor(d, { r, ch }) : undefined;
  const full = { ...res, baseline };
  writeFileSync(join(out, `${d.name}.json`), JSON.stringify(full, null, 1));
  results.push(full);
  const mm = res.measures;
  console.log(
    `[drill] ${d.name}: ${res.seconds.toFixed(1)}s, ${mm.runs.succeeded}/${mm.runs.expected} ok, not finished ${mm.runs.not_finished}, dupes ${mm.analytics.customer_visible_duplicates}, 429s ${Object.values(mm.providers).reduce((a, p) => a + p.over_limit_429, 0)}`,
  );
}
if (!names.length) writeFileSync(join(ROOT, "reports", "DRILLS.md"), markdown(results));
await closePg();
await closeRedis();
process.exit(0);

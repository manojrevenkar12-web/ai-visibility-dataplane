// Reset the stores and load a simulated world into Postgres.
import type { SQL } from "bun";
import type Redis from "ioredis";
import type { ClickHouse } from "../infra/clickhouse";
import { migratePg } from "../infra/pg";
import type { SimProject } from "../sim/world";

export async function resetStores(sql: SQL, r: Redis, ch: ClickHouse) {
  await migratePg(sql);
  await sql`TRUNCATE project, run, run_result, provider_call, quarantine, analytics_outbox, event_outbox, webhook_endpoint, webhook_delivery, leader_fence CASCADE`;
  await r.flushdb();
  await ch.migrate();
  for (const t of ["answers", "mentions", "citations"]) await ch.command(`TRUNCATE TABLE IF EXISTS ${t}`);
}

export async function seedWorld(
  sql: SQL,
  world: SimProject[],
  opts: { budgetEur?: (p: SimProject, i: number) => number; hookUrl?: (p: SimProject) => string | null; hookSecret?: string } = {},
) {
  for (const [i, p] of world.entries()) {
    await sql`INSERT INTO project(id, name, daily_budget_eur) VALUES (${p.id}, ${p.name}, ${opts.budgetEur?.(p, i) ?? 100})`;
    for (const b of p.brands) {
      await sql`INSERT INTO brand(id, project_id, name, aliases, domains, is_own, ambiguous)
               VALUES (${b.id}, ${p.id}, ${b.name}, ${sql.array(b.aliases)}, ${sql.array([b.domain])}, ${b.isOwn}, ${b.ambiguous})`;
    }
    const rows = p.prompts.map((q) => ({ id: q.id, project_id: p.id, text: q.text, country: q.country, interval_minutes: 1440 }));
    if (rows.length) await sql`INSERT INTO prompt ${sql(rows)}`;
    const hook = opts.hookUrl?.(p);
    if (hook)
      await sql`INSERT INTO webhook_endpoint(id, project_id, url, secret) VALUES (${`wh_${p.id}`}, ${p.id}, ${hook}, ${opts.hookSecret ?? "whsec_sim"})`;
  }
}

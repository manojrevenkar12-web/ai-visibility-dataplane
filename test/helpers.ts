import { ClickHouse } from "../src/infra/clickhouse";
import { env } from "../src/infra/config";
import { migratePg, pg } from "../src/infra/pg";
import { redis } from "../src/infra/redis";

export const sql = pg();
export const r = redis();
export const ch = new ClickHouse(env.clickhouseUrl, env.clickhouseDb);

let migrated = false;
export async function resetAll() {
  if (!migrated) {
    await migratePg(sql);
    await ch.migrate();
    migrated = true;
  }
  await sql`TRUNCATE project, run, run_result, provider_call, quarantine, analytics_outbox, event_outbox, webhook_endpoint, webhook_delivery, leader_fence CASCADE`;
  await r.flushdb();
  for (const t of ["answers", "mentions", "citations"]) await ch.command(`TRUNCATE TABLE IF EXISTS ${t}`);
}

export async function waitFor(cond: () => Promise<boolean>, ms = 20_000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await Bun.sleep(step);
  }
  throw new Error("timed out waiting");
}

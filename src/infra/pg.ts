// Postgres is the system of record for runs, results, outboxes and webhook deliveries.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { env, ROOT } from "./config";

let db: SQL | null = null;

export function pg(): SQL {
  db ??= new SQL({ url: env.databaseUrl, max: 20 });
  return db;
}

export async function closePg() {
  if (db) {
    await db.close();
    db = null;
  }
}

export async function migratePg(sql: SQL = pg()): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql`SELECT name FROM schema_migration`).map((r: { name: string }) => r.name));
  const dir = join(ROOT, "migrations", "postgres");
  const applied: string[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (done.has(f)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`INSERT INTO schema_migration(name) VALUES (${f})`;
    });
    applied.push(f);
  }
  return applied;
}

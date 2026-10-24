// A small ClickHouse HTTP client. The HTTP interface is the whole protocol we need: queries in the
// body, inserts as JSONEachRow, settings as URL parameters (insert_deduplication_token among them).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env, ROOT } from "./config";

export class ClickHouse {
  constructor(
    readonly url = env.clickhouseUrl,
    readonly database = env.clickhouseDb,
  ) {}

  private async post(params: Record<string, string>, body: string, db = true): Promise<string> {
    const u = new URL(this.url);
    if (db) u.searchParams.set("database", this.database);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u, { method: "POST", body });
    const text = await r.text();
    if (!r.ok) throw new Error(`clickhouse ${r.status}: ${text.slice(0, 300)}`);
    return text;
  }

  async command(sql: string, opts: { db?: boolean } = {}): Promise<void> {
    await this.post({}, sql, opts.db ?? true);
  }

  async query<T>(sql: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) p[`param_${k}`] = String(v);
    const text = await this.post(p, `${sql}\nFORMAT JSONEachRow`);
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  }

  /** Insert rows; a retried insert with the same token is dropped by ClickHouse itself. */
  async insert(table: string, rows: object[], dedupToken?: string): Promise<void> {
    if (!rows.length) return;
    const params: Record<string, string> = { query: `INSERT INTO ${table} FORMAT JSONEachRow` };
    if (dedupToken) params.insert_deduplication_token = dedupToken;
    await this.post(params, rows.map((r) => JSON.stringify(r)).join("\n"));
  }

  async migrate(): Promise<void> {
    await this.command(`CREATE DATABASE IF NOT EXISTS ${this.database}`, { db: false });
    const dir = join(ROOT, "migrations", "clickhouse");
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      for (const stmt of readFileSync(join(dir, f), "utf8").split(/;\s*\n/)) {
        const s = stmt.replace(/--.*$/gm, "").trim();
        if (s) await this.command(s);
      }
    }
  }
}

let ch: ClickHouse | null = null;
export function clickhouse(): ClickHouse {
  ch ??= new ClickHouse();
  return ch;
}

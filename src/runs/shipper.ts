// Ships completed runs from the Postgres outbox to ClickHouse. A crash between the ClickHouse
// insert and marking rows shipped means the same rows are sent again: the insert's deduplication
// token drops an identical batch, and ReplacingMergeTree (version = lease fence) collapses anything
// else, so customers never count a run twice.
import type { SQL } from "bun";
import type { ClickHouse } from "../infra/clickhouse";
import { settings } from "../infra/config";
import { log } from "../infra/log";
import { m } from "../infra/metrics";
import type { AnalyticsPayload } from "./types";

const chTime = (iso: string) => iso.replace("T", " ").replace("Z", "").slice(0, 23);

export class AnalyticsShipper {
  private running = false;
  /** Drills only: fail after the ClickHouse insert, before marking the rows shipped. */
  crashAfterInsertRate = 0;

  constructor(
    private readonly sql: SQL,
    private readonly ch: ClickHouse,
  ) {}

  async shipOnce(limit = settings().limits.analytics.batch_rows): Promise<number> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        SELECT o.run_id, o.fence, o.payload, r.created_at AS scheduled_at
        FROM analytics_outbox o JOIN run r ON r.id = o.run_id
        WHERE o.shipped_at IS NULL
        ORDER BY o.created_at, o.run_id LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED`;
      if (!rows.length) return 0;
      const answers: object[] = [];
      const mentions: object[] = [];
      const citations: object[] = [];
      for (const r of rows as { run_id: string; fence: string | number; payload: AnalyticsPayload }[]) {
        const p = r.payload;
        const v = Number(r.fence);
        const slot = chTime(p.run.slot).slice(0, 19);
        const base = {
          run_id: p.run.id,
          project_id: p.run.project_id,
          prompt_id: p.run.prompt_id,
          provider: p.run.provider,
          slot,
          version: v,
        };
        answers.push({
          ...base,
          country: p.run.country,
          model: p.model,
          answer_chars: p.answer_chars,
          brands_mentioned: p.mentions.filter((x) => x.mentioned).length,
          citations: p.citations.length,
          completed_at: chTime(p.completed_at),
        });
        for (const x of p.mentions)
          mentions.push({ ...base, brand_id: x.brand_id, is_own: x.is_own ? 1 : 0, mentioned: x.mentioned ? 1 : 0, position: x.position });
        for (const c of p.citations) citations.push({ ...base, url: c.url, domain: c.domain, source_type: c.source_type, rank: c.rank });
      }
      const token = new Bun.CryptoHasher("sha256")
        .update(rows.map((r: { run_id: string; fence: string | number }) => `${r.run_id}:${r.fence}`).join(","))
        .digest("hex");
      await this.ch.insert("answers", answers, `${token}:a`);
      await this.ch.insert("mentions", mentions, `${token}:m`);
      await this.ch.insert("citations", citations, `${token}:c`);
      m.analyticsRows.inc({ table: "answers" }, answers.length);
      m.analyticsRows.inc({ table: "mentions" }, mentions.length);
      m.analyticsRows.inc({ table: "citations" }, citations.length);
      if (this.crashAfterInsertRate && Math.random() < this.crashAfterInsertRate) throw new Error("drill: crash after ClickHouse insert");
      await tx`UPDATE analytics_outbox SET shipped_at = now() WHERE run_id IN ${tx(rows.map((r: { run_id: string }) => r.run_id))}`;
      const now = Date.now();
      for (const r of rows as { payload: AnalyticsPayload; scheduled_at: Date }[])
        m.runDuration.observe({ provider: r.payload.run.provider }, (now - new Date(r.scheduled_at).getTime()) / 1000);
      return rows.length;
    });
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const n = await this.shipOnce();
        const [p] = await this.sql`SELECT count(*)::int AS n FROM analytics_outbox WHERE shipped_at IS NULL`;
        m.analyticsLag.set(p?.n ?? 0);
        if (n === 0) await Bun.sleep(settings().limits.analytics.flush_ms);
      } catch (e) {
        log.warn("analytics ship failed; will retry", { err: String(e) });
        await Bun.sleep(200);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

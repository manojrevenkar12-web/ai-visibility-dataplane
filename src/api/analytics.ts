// Customer-facing analytics, read from ClickHouse with FINAL so a run is counted once even before
// ReplacingMergeTree has merged its versions.
import type { ClickHouse } from "../infra/clickhouse";

export interface Range {
  project: string;
  from: string; // YYYY-MM-DD HH:MM:SS (UTC)
  to: string;
  provider?: string;
}

const where = (r: Range) =>
  `project_id = {project:String} AND slot >= {from:DateTime} AND slot < {to:DateTime}${r.provider ? " AND provider = {provider:String}" : ""}`;
const params = (r: Range) => ({ project: r.project, from: r.from, to: r.to, ...(r.provider ? { provider: r.provider } : {}) });

export async function visibility(ch: ClickHouse, r: Range) {
  const rows = await ch.query<Record<string, string | number>>(
    `SELECT brand_id, any(is_own) AS is_own, count() AS answers, sum(mentioned) AS mentioned_count,
            round(avg(mentioned), 4) AS visibility, round(avgIf(position, mentioned = 1), 2) AS avg_position
     FROM mentions FINAL WHERE ${where(r)} GROUP BY brand_id ORDER BY visibility DESC, brand_id`,
    params(r),
  );
  const total = rows.reduce((s, x) => s + Number(x.mentioned_count), 0);
  return rows.map((x) => ({
    brand_id: String(x.brand_id),
    is_own: Number(x.is_own) === 1,
    answers: Number(x.answers),
    mentioned: Number(x.mentioned_count),
    visibility: Number(x.visibility),
    avg_position: x.avg_position === null || Number.isNaN(Number(x.avg_position)) ? null : Number(x.avg_position),
    share_of_voice: total ? Math.round((Number(x.mentioned_count) / total) * 10_000) / 10_000 : 0,
  }));
}

export async function visibilityByProvider(ch: ClickHouse, r: Range) {
  const rows = await ch.query<Record<string, string | number>>(
    `SELECT provider, brand_id, round(avg(mentioned), 4) AS visibility, count() AS answers
     FROM mentions FINAL WHERE ${where(r)} GROUP BY provider, brand_id ORDER BY provider, brand_id`,
    params(r),
  );
  return rows.map((x) => ({
    provider: String(x.provider),
    brand_id: String(x.brand_id),
    visibility: Number(x.visibility),
    answers: Number(x.answers),
  }));
}

export async function sources(ch: ClickHouse, r: Range, limit = 50) {
  const rows = await ch.query<Record<string, string | number>>(
    `SELECT domain, any(source_type) AS source_type, count() AS citations, uniqExact(run_id) AS answers, round(avg(rank), 2) AS avg_rank
     FROM citations FINAL WHERE ${where(r)} GROUP BY domain ORDER BY citations DESC, domain LIMIT ${Math.min(500, Math.max(1, Math.floor(limit)))}`,
    params(r),
  );
  return rows.map((x) => ({
    domain: String(x.domain),
    source_type: String(x.source_type),
    citations: Number(x.citations),
    answers: Number(x.answers),
    avg_rank: Number(x.avg_rank),
  }));
}

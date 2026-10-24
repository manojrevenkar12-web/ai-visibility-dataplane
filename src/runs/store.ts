// Postgres access for runs. Every write that completes or fails a run is fenced: it applies only
// while the run still carries the fence of the lease that is writing.
import type { SQL } from "bun";
import type { BrandRef } from "../extract/mentions";
import type { AnalyticsPayload, RunJob } from "./types";

export interface ProjectInfo {
  id: string;
  dailyBudgetEur: number;
  brands: (BrandRef & { isOwn: boolean })[];
}

export class RunStore {
  private projects = new Map<string, { at: number; info: ProjectInfo }>();

  constructor(private readonly sql: SQL) {}

  async project(id: string): Promise<ProjectInfo> {
    const hit = this.projects.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.info;
    const [p] = await this.sql`SELECT id, daily_budget_eur FROM project WHERE id = ${id}`;
    const brands = await this.sql`SELECT id, name, aliases, domains, is_own, ambiguous FROM brand WHERE project_id = ${id} ORDER BY id`;
    const info: ProjectInfo = {
      id,
      dailyBudgetEur: Number(p?.daily_budget_eur ?? 0),
      brands: brands.map((b: Record<string, unknown>) => ({
        id: b.id as string,
        name: b.name as string,
        aliases: b.aliases as string[],
        domains: b.domains as string[],
        ambiguous: b.ambiguous as boolean,
        isOwn: b.is_own as boolean,
      })),
    };
    this.projects.set(id, { at: Date.now(), info });
    return info;
  }

  /** Take the run for this lease. False if a newer lease already owns it, or it is already done. */
  async claim(runId: string, fence: number, attempt: number): Promise<boolean> {
    const r = await this.sql`
      UPDATE run SET fence = ${fence}, attempts = ${attempt}, status = 'queued'
      WHERE id = ${runId} AND fence < ${fence} AND status IN ('pending', 'queued')
      RETURNING id`;
    return r.length === 1;
  }

  async recordCall(
    runId: string,
    provider: string,
    attempt: number,
    outcome: string,
    httpStatus: number | null,
    latencyMs: number,
    costEur: number,
  ) {
    await this.sql`
      INSERT INTO provider_call(run_id, provider, attempt, outcome, http_status, latency_ms, cost_eur)
      VALUES (${runId}, ${provider}, ${attempt}, ${outcome}, ${httpStatus}, ${latencyMs}, ${costEur})`;
    if (costEur > 0) await this.sql`UPDATE run SET cost_eur = cost_eur + ${costEur} WHERE id = ${runId}`;
  }

  /** The result, the analytics row and the event, in one transaction, under the fence. */
  async complete(
    job: RunJob,
    fence: number,
    result: { model: string; requestId: string | null; text: string; raw: unknown; parser: string },
    analytics: AnalyticsPayload,
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const r = await tx`
        UPDATE run SET status = 'succeeded', finished_at = now(), error_kind = NULL, last_error = NULL
        WHERE id = ${job.runId} AND fence = ${fence} AND status <> 'succeeded'
        RETURNING id`;
      if (r.length !== 1) return false;
      await tx`
        INSERT INTO run_result(run_id, model, provider_request_id, answer_text, raw, parser, fence)
        VALUES (${job.runId}, ${result.model}, ${result.requestId}, ${result.text}, ${result.raw}, ${result.parser}, ${fence})
        ON CONFLICT (run_id) DO UPDATE SET model = EXCLUDED.model, answer_text = EXCLUDED.answer_text, raw = EXCLUDED.raw, parser = EXCLUDED.parser, fence = EXCLUDED.fence`;
      await tx`
        INSERT INTO analytics_outbox(run_id, fence, payload) VALUES (${job.runId}, ${fence}, ${analytics})
        ON CONFLICT (run_id) DO UPDATE SET fence = EXCLUDED.fence, payload = EXCLUDED.payload, shipped_at = NULL`;
      const mentioned = analytics.mentions.filter((m) => m.mentioned);
      await tx`
        INSERT INTO event_outbox(event_id, project_id, type, payload)
        VALUES (${`run.completed:${job.runId}`}, ${job.projectId}, 'run.completed', ${{
          run_id: job.runId,
          prompt_id: job.promptId,
          provider: job.provider,
          slot: job.slot,
          brands_mentioned: mentioned.map((m) => ({ brand_id: m.brand_id, position: m.position })),
          citations: analytics.citations.length,
        }})
        ON CONFLICT (event_id) DO NOTHING`;
      return true;
    });
  }

  async fail(job: RunJob, fence: number, kind: string, message: string, status: "failed" | "skipped_budget" = "failed"): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const r = await tx`
        UPDATE run SET status = ${status}, finished_at = now(), error_kind = ${kind}, last_error = ${message.slice(0, 500)}
        WHERE id = ${job.runId} AND fence = ${fence} AND status <> 'succeeded'
        RETURNING id`;
      if (r.length !== 1) return false;
      const type = status === "skipped_budget" ? "budget.exhausted" : "run.failed";
      const eventId =
        status === "skipped_budget" ? `budget.exhausted:${job.projectId}:${job.slot.slice(0, 10)}` : `run.failed:${job.runId}`;
      await tx`
        INSERT INTO event_outbox(event_id, project_id, type, payload)
        VALUES (${eventId}, ${job.projectId}, ${type}, ${{ run_id: job.runId, provider: job.provider, reason: kind }})
        ON CONFLICT (event_id) DO NOTHING`;
      return true;
    });
  }

  async quarantine(runId: string, provider: string, reason: string, sample: string) {
    await this
      .sql`INSERT INTO quarantine(run_id, provider, reason, sample) VALUES (${runId}, ${provider}, ${reason}, ${sample.slice(0, 200_000)})`;
  }
}

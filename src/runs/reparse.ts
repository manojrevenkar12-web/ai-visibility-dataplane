// After a parser fix: complete runs that failed with schema drift from the response bodies kept in
// quarantine, without calling (or paying) the provider again.
import type { SQL } from "bun";
import type Redis from "ioredis";
import { settings } from "../infra/config";
import { log } from "../infra/log";
import { parseBody } from "../providers/parsers";
import { Queue } from "../queue/queue";
import { toAnalytics } from "./extract";
import { RunStore } from "./store";
import type { RunJob } from "./types";
import { RUN_QUEUE } from "./worker";

export async function reparseQuarantine(
  sql: SQL,
  r: Redis,
  fetchImpl: typeof fetch = fetch,
): Promise<{ resolved: number; still_unknown: number }> {
  const store = new RunStore(sql);
  const queue = new Queue<RunJob>(r, RUN_QUEUE, settings().limits.queue.lease_ms);
  const rows = await sql`
    SELECT DISTINCT ON (q.run_id) q.id, q.run_id, q.provider, q.sample, r.project_id, r.prompt_id, r.country, r.slot, p.text
    FROM quarantine q JOIN run r ON r.id = q.run_id JOIN prompt p ON p.id = r.prompt_id
    WHERE q.resolved_at IS NULL AND r.status = 'failed' AND r.error_kind = 'schema_drift'
    ORDER BY q.run_id, q.id DESC`;
  let resolved = 0;
  let unknown = 0;
  for (const q of rows) {
    const cfg = settings().providers[q.provider];
    if (!cfg) continue;
    const parsed = parseBody(cfg.format, q.sample);
    if (!parsed.ok) {
      unknown++;
      continue;
    }
    const job: RunJob = {
      runId: q.run_id,
      projectId: q.project_id,
      promptId: q.prompt_id,
      provider: q.provider,
      country: q.country,
      slot: new Date(q.slot).toISOString(),
      prompt: q.text,
      queuedAt: Date.now(),
    };
    // a fresh fence from the queue's counter keeps the write ordered with any worker activity
    const fence = Number(await r.incr(queue.k.fence));
    const claimed =
      await sql`UPDATE run SET fence = ${fence}, status = 'queued' WHERE id = ${q.run_id} AND fence < ${fence} AND status = 'failed' RETURNING id`;
    if (!claimed.length) continue;
    const answer = { ...parsed.answer, requestId: null };
    const analytics = await toAnalytics(job, await store.project(job.projectId), answer, fetchImpl);
    if (
      await store.complete(
        job,
        fence,
        { model: answer.model, requestId: null, text: answer.text, raw: JSON.parse(q.sample), parser: answer.parser },
        analytics,
      )
    ) {
      await sql`UPDATE quarantine SET resolved_at = now(), resolved_by = ${answer.parser} WHERE run_id = ${q.run_id} AND resolved_at IS NULL`;
      resolved++;
    }
  }
  log.info("reparsed quarantine", { resolved, still_unknown: unknown });
  return { resolved, still_unknown: unknown };
}

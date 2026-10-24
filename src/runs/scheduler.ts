// The scheduler: turn tracked prompts into runs for the current slot, and feed the queue without
// overfilling it.
//
// One scheduler is leader at a time (a fenced Redis lock; the fence is also checked in Postgres, so
// a deposed leader that wakes up cannot act). Each tick it (1) inserts the runs due in this slot,
// idempotently, (2) moves pending runs into the queue up to the high-water mark, oldest first, and
// (3) reconciles: runs Postgres believes are queued but Redis has lost (restart, eviction, failover)
// go back to pending. Postgres is the record; the queue can always be rebuilt from it.
import type { SQL } from "bun";
import type Redis from "ioredis";
import { settings } from "../infra/config";
import { log } from "../infra/log";
import { m } from "../infra/metrics";
import { checkFence, FencedLock } from "../limits/lock";
import { Queue } from "../queue/queue";
import { runId, slotOf } from "./ids";
import type { RunJob } from "./types";
import { RUN_QUEUE } from "./worker";

export class Scheduler {
  readonly queue: Queue<RunJob>;
  readonly lock: FencedLock;
  private running = false;
  private lastPlan = 0;
  /** Planning a slot is idempotent but not free; once every this many ms is enough. */
  planEveryMs = 30_000;

  constructor(
    private readonly r: Redis,
    private readonly sql: SQL,
    owner = `scheduler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  ) {
    this.queue = new Queue<RunJob>(r, RUN_QUEUE, settings().limits.queue.lease_ms);
    this.lock = new FencedLock(r, "scheduler", owner, 10_000);
  }

  /** Insert this slot's runs. Returns how many were new. */
  async plan(now = new Date()): Promise<number> {
    const prompts = await this.sql`
      SELECT q.id, q.project_id, q.country, q.interval_minutes, p.providers
      FROM prompt q JOIN project p ON p.id = q.project_id WHERE q.active`;
    const rows: Record<string, unknown>[] = [];
    for (const q of prompts) {
      const slot = slotOf(now, q.interval_minutes);
      for (const provider of q.providers as string[]) {
        rows.push({
          id: runId(q.id, provider, q.country, slot),
          project_id: q.project_id,
          prompt_id: q.id,
          provider,
          country: q.country,
          slot,
        });
      }
    }
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const r = await this.sql`INSERT INTO run ${this.sql(rows.slice(i, i + 1000))} ON CONFLICT (id) DO NOTHING RETURNING id`;
      inserted += r.length;
    }
    return inserted;
  }

  /** Move pending runs into the queue, up to the high-water mark. Returns how many. */
  async feed(fence: number): Promise<number> {
    const d = await this.queue.depth();
    m.queueDepth.set({ state: "ready" }, d.ready);
    m.queueDepth.set({ state: "leased" }, d.leased);
    const room = settings().limits.queue.high_water - d.ready - d.leased;
    if (room <= 0) {
      m.scheduleDeferred.inc();
      return 0;
    }
    return this.sql.begin(async (tx) => {
      if (!(await checkFence(tx, "scheduler", fence))) throw new Error("deposed: a newer scheduler holds the lock");
      const runs = await tx`
        SELECT r.id, r.project_id, r.prompt_id, r.provider, r.country, r.slot, q.text
        FROM run r JOIN prompt q ON q.id = r.prompt_id
        WHERE r.status = 'pending' ORDER BY r.created_at, r.id LIMIT ${room} FOR UPDATE OF r SKIP LOCKED`;
      for (const x of runs) {
        await this.queue.enqueue(x.id, {
          runId: x.id,
          projectId: x.project_id,
          promptId: x.prompt_id,
          provider: x.provider,
          country: x.country,
          slot: new Date(x.slot).toISOString(),
          prompt: x.text,
          queuedAt: Date.now(),
        });
      }
      if (runs.length)
        await tx`UPDATE run SET status = 'queued', queued_at = now() WHERE id IN ${tx(runs.map((x: { id: string }) => x.id))} AND status = 'pending'`;
      return runs.length;
    });
  }

  /** Runs marked queued that the queue no longer has go back to pending. */
  async reconcile(olderThanMs = 5000): Promise<number> {
    const stale = await this.sql`
      SELECT id FROM run WHERE status = 'queued' AND coalesce(queued_at, created_at) < now() - (${olderThanMs} || ' milliseconds')::interval
      ORDER BY queued_at LIMIT 2000`;
    if (!stale.length) return 0;
    const pipe = this.r.pipeline();
    for (const s of stale) pipe.hexists(this.queue.k.job(s.id), "payload");
    const exists = (await pipe.exec()) ?? [];
    const lost = stale.filter((_: unknown, i: number) => exists[i]?.[1] === 0).map((s: { id: string }) => s.id);
    if (!lost.length) return 0;
    const r = await this.sql`UPDATE run SET status = 'pending' WHERE id IN ${this.sql(lost)} AND status = 'queued' RETURNING id`;
    if (r.length) log.warn("re-queued runs the queue had lost", { count: r.length });
    return r.length;
  }

  async tick(now = new Date()): Promise<{ leader: boolean; planned: number; fed: number; reconciled: number }> {
    const fence = await this.lock.acquire();
    if (!fence) return { leader: false, planned: 0, fed: 0, reconciled: 0 };
    let planned = 0;
    if (Date.now() - this.lastPlan >= this.planEveryMs) {
      planned = await this.plan(now);
      this.lastPlan = Date.now();
    }
    const reconciled = await this.reconcile();
    const fed = await this.feed(fence);
    return { leader: true, planned, fed, reconciled };
  }

  async start(intervalMs = 200): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        log.error("scheduler tick failed", { err: String(e) });
      }
      await Bun.sleep(intervalMs);
    }
  }

  async stop() {
    this.running = false;
    await this.lock.release();
  }
}

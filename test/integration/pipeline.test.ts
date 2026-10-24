// The whole path in one process: scheduler -> queue -> worker -> Postgres -> outboxes -> ClickHouse
// and webhooks, against the provider simulator.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { buildApi } from "../../src/api/app";
import { seedWorld } from "../../src/drills/seed";
import { overrideSettings, resetSettings, settings } from "../../src/infra/config";
import { disabledParsers } from "../../src/providers/parsers";
import { reparseQuarantine } from "../../src/runs/reparse";
import { Scheduler } from "../../src/runs/scheduler";
import { AnalyticsShipper } from "../../src/runs/shipper";
import { Worker } from "../../src/runs/worker";
import { type ProviderFaults, ProviderSim } from "../../src/sim/provider-sim";
import { makeWorld } from "../../src/sim/world";
import { WebhookDeliverer } from "../../src/webhooks/webhooks";
import { ch, r, resetAll, sql, waitFor } from "../helpers";

const PROVIDERS = Object.keys(settings().providers);
const world = makeWorld(2, 4, "pipeline");
const costs = Object.fromEntries(PROVIDERS.map((p) => [p, settings().providers[p]!.cost_eur]));
const sims: ProviderSim[] = [];

function sim(per: Partial<Record<string, Partial<ProviderFaults>>> = {}) {
  const s = new ProviderSim(
    {
      seed: "pipe",
      costs,
      providers: Object.fromEntries(PROVIDERS.map((p) => [p, { limitPerSecond: 200, latencyMs: [1, 5] as [number, number], ...per[p] }])),
    },
    world,
  ).listen();
  sims.push(s);
  return s;
}

afterAll(() => {
  for (const s of sims) s.stop();
});

async function runAll(s: ProviderSim, opts: { budget?: number } = {}) {
  await seedWorld(sql, world, { budgetEur: () => opts.budget ?? 100, hookUrl: (p) => s.registerHook(p.id, 0.2) });
  const scheduler = new Scheduler(r, sql);
  expect((await scheduler.tick()).planned).toBe(40);
  expect((await scheduler.tick()).planned).toBe(0); // idempotent
  const worker = new Worker(r, sql, { providerBaseUrl: s.url, concurrency: 8 });
  const shipper = new AnalyticsShipper(sql, ch);
  const hooks = new WebhookDeliverer(sql);
  const loops = [worker.start(), shipper.start(), hooks.start()];
  await waitFor(async () => {
    await scheduler.tick();
    const [x] = await sql`SELECT count(*) FILTER (WHERE status IN ('pending','queued'))::int AS open FROM run`;
    const [y] = await sql`SELECT count(*) FILTER (WHERE shipped_at IS NULL)::int AS n FROM analytics_outbox`;
    const [z] = await sql`SELECT count(*)::int AS n FROM webhook_delivery WHERE status = 'pending'`;
    const [e] = await sql`SELECT count(*)::int AS n FROM event_outbox WHERE fanned_out_at IS NULL`;
    return x.open === 0 && y.n === 0 && z.n === 0 && e.n === 0;
  }, 30_000);
  await worker.stop();
  await scheduler.lock.release();
  shipper.stop();
  hooks.stop();
  await Promise.all(loops);
}

beforeEach(resetAll);

describe("pipeline", () => {
  test("every run is collected once, lands in ClickHouse once, and its event is delivered", async () => {
    const s = sim({ openai: { errorRate: 0.2, truncatedRate: 0.1 } });
    await runAll(s);
    const [st] = await sql`SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*)::int AS n FROM run`;
    expect(st).toEqual({ ok: 40, n: 40 });
    const [c] = await ch.query<{ rows: string; runs: string }>("SELECT count() AS rows, uniqExact(run_id) AS runs FROM answers FINAL");
    expect([Number(c!.rows), Number(c!.runs)]).toEqual([40, 40]);
    const received = [...s.hooks.values()].reduce((a, h) => a + h.received.size, 0);
    expect(received).toBe(40);
    expect([...s.hooks.values()].every((h) => h.badSignatures === 0)).toBe(true);
    // each paid call is in the ledger, and the ledger matches what the provider billed
    const [led] = await sql`SELECT sum(cost_eur)::float AS eur FROM provider_call`;
    const billed = Object.values(s.stats()).reduce((a, x) => a + x.costEur, 0);
    expect(led.eur).toBeCloseTo(billed, 6);
  });

  test("shipping the same outbox twice does not double-count", async () => {
    const s = sim();
    await runAll(s);
    await sql`UPDATE analytics_outbox SET shipped_at = NULL`; // as if the marks were lost after the inserts
    const shipper = new AnalyticsShipper(sql, ch);
    while ((await shipper.shipOnce()) > 0);
    const [c] = await ch.query<{ rows: string; runs: string }>("SELECT count() AS rows, uniqExact(run_id) AS runs FROM mentions FINAL");
    const brands = world.reduce((a, p) => a + p.brands.length * p.prompts.length * PROVIDERS.length, 0);
    expect(Number(c!.rows)).toBe(brands);
  });

  test("a project over its daily budget is skipped, not overrun", async () => {
    const s = sim();
    await runAll(s, { budget: 0.1 });
    const rows =
      await sql`SELECT r.project_id, sum(c.cost_eur)::float AS eur FROM provider_call c JOIN run r ON r.id = c.run_id GROUP BY 1`;
    for (const x of rows) expect(x.eur).toBeLessThanOrEqual(0.1 + 1e-9);
    const [sk] = await sql`SELECT count(*)::int AS n FROM run WHERE status = 'skipped_budget'`;
    expect(sk.n).toBeGreaterThan(0);
    const [ev] = await sql`SELECT count(*)::int AS n FROM event_outbox WHERE type = 'budget.exhausted'`;
    expect(ev.n).toBe(2); // one per project and day, however many runs were skipped
  });

  test("schema drift: the body is kept, not paid for twice, and recovered after the parser fix", async () => {
    const s = sim({ openai: { driftAtMs: 0 } });
    disabledParsers.add("openai.chat.v2-parts");
    try {
      await runAll(s);
    } finally {
      disabledParsers.delete("openai.chat.v2-parts");
    }
    const [f] = await sql`SELECT count(*)::int AS n FROM run WHERE error_kind = 'schema_drift'`;
    expect(f.n).toBe(8);
    expect(s.stats().openai!.requests).toBe(8); // no retries of a response we cannot read
    const res = await reparseQuarantine(sql, r);
    expect(res).toEqual({ resolved: 8, still_unknown: 0 });
    const shipper = new AnalyticsShipper(sql, ch);
    while ((await shipper.shipOnce()) > 0);
    const [c] = await ch.query<{ runs: string }>("SELECT uniqExact(run_id) AS runs FROM answers FINAL WHERE provider = 'openai'");
    expect(Number(c!.runs)).toBe(8);
    expect(s.stats().openai!.requests).toBe(8);
  });

  test("runs the queue lost are found and run again", async () => {
    const s = sim();
    await seedWorld(sql, world, {});
    const scheduler = new Scheduler(r, sql);
    await scheduler.tick();
    await r.del(...(await r.keys("q:{runs}:*"))); // Redis failover without the latest writes
    await sql`UPDATE run SET queued_at = now() - interval '1 minute'`;
    expect(await scheduler.reconcile(1000)).toBe(40);
    await scheduler.tick();
    expect((await scheduler.queue.depth()).ready).toBe(40);
    await scheduler.lock.release();
    void s;
  });

  test("a stale worker's result is refused", async () => {
    const s = sim();
    await seedWorld(sql, world, {});
    await sql`UPDATE prompt SET active = (id = ${world[0]!.prompts[0]!.id})`;
    await sql`UPDATE project SET providers = ARRAY['openai']`;
    const scheduler = new Scheduler(r, sql);
    await scheduler.tick();
    const w = new Worker(r, sql, { providerBaseUrl: s.url, concurrency: 1 });
    const [l1] = await w.queue.lease(1);
    await w.queue.reap(Date.now() + 60_000); // l1's holder stalled past its lease
    const [l2] = await w.queue.lease(1, Date.now() + 60_000);
    expect(l2!.id).toBe(l1!.id);
    await w.process(l2!); // the new holder finishes
    await w.process(l1!); // the old one wakes up
    await scheduler.lock.release();
    const [x] = await sql`SELECT status, fence::int AS fence FROM run WHERE id = ${l1!.id}`;
    expect(x).toEqual({ status: "succeeded", fence: l2!.fence });
    const [calls] = await sql`SELECT count(*)::int AS n FROM provider_call WHERE run_id = ${l1!.id}`;
    expect(calls.n).toBe(1); // the stale holder did not call (and pay) again
  });
});

describe("API", () => {
  test("configure, read analytics and run status, auth", async () => {
    const s = sim({ perplexity: { outages: [{ fromMs: 0, toMs: 60_000, mode: "503" }] } });
    overrideSettings({ limits: { queue: { max_age_ms: 3000 } } }); // perplexity stays down: its runs are given up and reported
    const app = buildApi({ sql, redis: r, ch, apiKeys: "admin:*,p1key:p001" });
    const call = (path: string, init: RequestInit & { key?: string } = {}) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...(init.key ? { "x-api-key": init.key } : {}) },
        }),
      );
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/v1/projects", { method: "POST", body: JSON.stringify({ id: "p001", name: "x" }) })).status).toBe(401);
    expect((await call("/v1/projects", { method: "POST", key: "p1key", body: JSON.stringify({ id: "p001", name: "x" }) })).status).toBe(
      403,
    );
    expect((await call("/v1/projects", { method: "POST", key: "admin", body: JSON.stringify({ id: "BAD ID", name: "x" }) })).status).toBe(
      422,
    );
    await runAll(s);
    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const vis = (await (await call(`/v1/projects/p001/visibility?from=${day}&to=${tomorrow}`, { key: "p1key" })).json()) as {
      brands: { visibility: number; answers: number }[];
    };
    expect(vis.brands.length).toBe(world[0]!.brands.length);
    expect(vis.brands[0]!.answers).toBe(16); // 4 prompts x 4 providers that answered
    expect((await call(`/v1/projects/p002/visibility?from=${day}&to=${tomorrow}`, { key: "p1key" })).status).toBe(403);
    const src = (await (await call(`/v1/projects/p001/sources?from=${day}&to=${tomorrow}`, { key: "p1key" })).json()) as {
      sources: { domain: string; source_type: string }[];
    };
    expect(src.sources.length).toBeGreaterThan(0);
    const runs = (await (await call(`/v1/projects/p001/runs?from=${day}&to=${tomorrow}`, { key: "p1key" })).json()) as {
      problems: { provider: string; message: string }[];
    };
    expect(runs.problems[0]!.provider).toBe("perplexity");
    expect(runs.problems[0]!.message).not.toContain("503"); // customer-safe wording, no internals
    const hook = await call("/v1/projects/p001/webhooks", {
      method: "POST",
      key: "p1key",
      body: JSON.stringify({ url: "https://example.com/hook" }),
    });
    expect(hook.status).toBe(201);
    expect(((await hook.json()) as { secret: string }).secret).toStartWith("whsec_");
    const metrics = await (await call("/metrics")).text();
    expect(metrics).toContain("avd_runs_total");
    resetSettings();
  });
});

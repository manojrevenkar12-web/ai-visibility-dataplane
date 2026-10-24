// The HTTP API (Elysia on Bun): configure what a project tracks, read its analytics, see the state
// of its runs in customer-safe terms, register webhooks; plus health, readiness and metrics.
import type { SQL } from "bun";
import { Elysia, t } from "elysia";
import type Redis from "ioredis";
import type { ClickHouse } from "../infra/clickhouse";
import { settings } from "../infra/config";
import { m, registry } from "../infra/metrics";
import { CircuitBreaker } from "../limits/circuit";
import { Semaphore } from "../limits/concurrency";
import { RateLimiter } from "../limits/rate";
import { Queue } from "../queue/queue";
import { RUN_QUEUE } from "../runs/worker";
import { sources, visibility, visibilityByProvider } from "./analytics";

/** What a customer is told about a run that did not produce data. Internal detail stays in logs. */
export const CUSTOMER_MESSAGES: Record<string, string> = {
  budget: "Skipped: the project's daily tracking budget was reached. It resets at midnight UTC.",
  expired: "Not collected: the AI provider was unavailable for this whole tracking period. It will be collected in the next scheduled run.",
  exhausted: "Not collected: the AI provider was unavailable for longer than we retry. It will be collected in the next scheduled run.",
  unavailable: "Not collected: the AI provider was unavailable. It will be collected in the next scheduled run.",
  truncated: "Not collected: the AI provider returned an incomplete answer repeatedly.",
  schema_drift: "Delayed: the AI provider changed its answer format. We have the answer and will process it shortly; no action needed.",
  rejected: "Not collected: the provider rejected the request. Our team has been alerted.",
};

export function parseKeys(raw: string): Map<string, Set<string> | "*"> {
  const out = new Map<string, Set<string> | "*">();
  for (const part of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [key, scope] = part.split(":");
    if (!key) continue;
    out.set(key, !scope || scope === "*" ? "*" : new Set(scope.split("|")));
  }
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const toCh = (d: string) => `${d} 00:00:00`;

export function buildApi(deps: { sql: SQL; redis: Redis; ch: ClickHouse; apiKeys?: string }) {
  const { sql, redis, ch } = deps;
  const keys = parseKeys(deps.apiKeys ?? "");
  const open = keys.size === 0;
  const queue = new Queue(redis, RUN_QUEUE, settings().limits.queue.lease_ms);
  const circuit = new CircuitBreaker(redis);
  const sem = new Semaphore(redis);
  const rate = new RateLimiter(redis);

  const allowed = (key: string | undefined, project: string) => {
    if (open) return true;
    const scope = key ? keys.get(key) : undefined;
    return scope === "*" || (scope instanceof Set && scope.has(project));
  };

  return new Elysia()
    .onAfterResponse(({ request, set, route }) => {
      m.httpRequests.inc({ route: route ?? new URL(request.url).pathname, status: String(set.status ?? 200) });
    })
    .get("/healthz", () => ({ ok: true }))
    .get("/readyz", async ({ set }) => {
      const checks: Record<string, boolean> = {};
      checks.postgres = await sql`SELECT 1`.then(
        () => true,
        () => false,
      );
      checks.redis = await redis.ping().then(
        (x) => x === "PONG",
        () => false,
      );
      checks.clickhouse = await ch.query("SELECT 1 AS ok").then(
        () => true,
        () => false,
      );
      const ok = Object.values(checks).every(Boolean);
      if (!ok) set.status = 503;
      return { ok, checks };
    })
    .get("/metrics", async ({ set }) => {
      set.headers["content-type"] = registry.contentType;
      return registry.metrics();
    })
    .guard({
      beforeHandle({ headers, params, set }) {
        const project = (params as Record<string, string> | undefined)?.id;
        const key = headers["x-api-key"];
        if (!open && (!key || !keys.has(key))) {
          set.status = 401;
          return { error: "missing or unknown x-api-key" };
        }
        if (project && !allowed(key, project)) {
          set.status = 403;
          return { error: "this key cannot access that project" };
        }
      },
    })
    .post(
      "/v1/projects",
      async ({ body, set, headers }) => {
        if (!open && keys.get(headers["x-api-key"] ?? "") !== "*") {
          set.status = 403;
          return { error: "creating projects needs an admin key" };
        }
        await sql`
          INSERT INTO project(id, name, daily_budget_eur, providers) VALUES (${body.id}, ${body.name}, ${body.daily_budget_eur ?? 50}, ${sql.array(body.providers ?? Object.keys(settings().providers))})
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, daily_budget_eur = EXCLUDED.daily_budget_eur, providers = EXCLUDED.providers`;
        set.status = 201;
        return { id: body.id };
      },
      {
        body: t.Object({
          id: t.String({ pattern: "^[a-z0-9-]{2,40}$" }),
          name: t.String({ minLength: 1, maxLength: 200 }),
          daily_budget_eur: t.Optional(t.Number({ minimum: 0, maximum: 100000 })),
          providers: t.Optional(t.Array(t.String(), { minItems: 1 })),
        }),
      },
    )
    .put(
      "/v1/projects/:id/brands",
      async ({ params, body }) => {
        await sql.begin(async (tx) => {
          await tx`DELETE FROM brand WHERE project_id = ${params.id}`;
          for (const b of body) {
            await tx`INSERT INTO brand(id, project_id, name, aliases, domains, is_own, ambiguous)
                     VALUES (${b.id}, ${params.id}, ${b.name}, ${tx.array(b.aliases ?? [])}, ${tx.array(b.domains ?? [])}, ${b.is_own ?? false}, ${b.ambiguous ?? false})`;
          }
        });
        return { brands: body.length };
      },
      {
        body: t.Array(
          t.Object({
            id: t.String({ minLength: 1, maxLength: 80 }),
            name: t.String({ minLength: 1, maxLength: 120 }),
            aliases: t.Optional(t.Array(t.String({ maxLength: 120 }))),
            domains: t.Optional(t.Array(t.String({ maxLength: 120 }))),
            is_own: t.Optional(t.Boolean()),
            ambiguous: t.Optional(t.Boolean()),
          }),
          { maxItems: 100 },
        ),
      },
    )
    .put(
      "/v1/projects/:id/prompts",
      async ({ params, body }) => {
        await sql.begin(async (tx) => {
          await tx`UPDATE prompt SET active = false WHERE project_id = ${params.id}`;
          for (const q of body) {
            await tx`INSERT INTO prompt(id, project_id, text, country, interval_minutes, active)
                     VALUES (${q.id}, ${params.id}, ${q.text}, ${q.country ?? "DE"}, ${q.interval_minutes ?? 1440}, true)
                     ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, country = EXCLUDED.country, interval_minutes = EXCLUDED.interval_minutes, active = true`;
          }
        });
        return { prompts: body.length };
      },
      {
        body: t.Array(
          t.Object({
            id: t.String({ minLength: 1, maxLength: 80 }),
            text: t.String({ minLength: 2, maxLength: 1000 }),
            country: t.Optional(t.String({ pattern: "^[A-Z]{2}$" })),
            interval_minutes: t.Optional(t.Integer({ minimum: 1, maximum: 10080 })),
          }),
          { maxItems: 5000 },
        ),
      },
    )
    .get(
      "/v1/projects/:id/visibility",
      async ({ params, query }) => {
        const r = { project: params.id, from: toCh(query.from), to: toCh(query.to), provider: query.provider };
        return { brands: await visibility(ch, r), by_provider: await visibilityByProvider(ch, r) };
      },
      {
        query: t.Object({
          from: t.String({ pattern: DAY.source }),
          to: t.String({ pattern: DAY.source }),
          provider: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/v1/projects/:id/sources",
      async ({ params, query }) => ({
        sources: await sources(
          ch,
          { project: params.id, from: toCh(query.from), to: toCh(query.to), provider: query.provider },
          Number(query.limit ?? 50),
        ),
      }),
      {
        query: t.Object({
          from: t.String({ pattern: DAY.source }),
          to: t.String({ pattern: DAY.source }),
          provider: t.Optional(t.String()),
          limit: t.Optional(t.Numeric()),
        }),
      },
    )
    .get(
      "/v1/projects/:id/runs",
      async ({ params, query }) => {
        const counts = await sql`
          SELECT provider, status, count(*)::int AS n FROM run
          WHERE project_id = ${params.id} AND slot >= ${new Date(`${query.from}T00:00:00Z`)} AND slot < ${new Date(`${query.to}T00:00:00Z`)}
          GROUP BY provider, status ORDER BY provider, status`;
        const problems = await sql`
          SELECT provider, error_kind, count(*)::int AS n FROM run
          WHERE project_id = ${params.id} AND status IN ('failed', 'skipped_budget') AND slot >= ${new Date(`${query.from}T00:00:00Z`)} AND slot < ${new Date(`${query.to}T00:00:00Z`)}
          GROUP BY provider, error_kind ORDER BY n DESC`;
        return {
          counts,
          problems: problems.map((p: { provider: string; error_kind: string; n: number }) => ({
            provider: p.provider,
            runs: p.n,
            message: CUSTOMER_MESSAGES[p.error_kind] ?? "Not collected. Our team has been alerted.",
          })),
        };
      },
      { query: t.Object({ from: t.String({ pattern: DAY.source }), to: t.String({ pattern: DAY.source }) }) },
    )
    .post(
      "/v1/projects/:id/webhooks",
      async ({ params, body, set }) => {
        const id = `wh_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const secret = body.secret ?? `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
        await sql`INSERT INTO webhook_endpoint(id, project_id, url, secret, event_types) VALUES (${id}, ${params.id}, ${body.url}, ${secret}, ${sql.array(body.event_types ?? ["run.completed", "run.failed", "budget.exhausted"])})`;
        set.status = 201;
        return { id, secret }; // the secret is shown once
      },
      {
        body: t.Object({
          url: t.String({ format: "uri", maxLength: 2000 }),
          event_types: t.Optional(t.Array(t.String())),
          secret: t.Optional(t.String({ minLength: 8 })),
        }),
      },
    )
    .get("/v1/ops/providers", async () => {
      const d = await queue.depth();
      const out: Record<string, unknown> = {};
      for (const p of Object.keys(settings().providers)) {
        const pause = Number((await redis.get(`rl:{${p}}:pause`)) ?? 0);
        const cfg = settings().providers[p]!;
        out[p] = {
          circuit: await circuit.state(p),
          in_flight: await sem.inFlight(p),
          paused_ms: Math.max(0, pause - Date.now()),
          rate_per_second: { configured: cfg.rate.per_second, effective: await rate.effectiveRate(p, cfg.rate.per_second) },
        };
      }
      return { queue: d, providers: out };
    });
}

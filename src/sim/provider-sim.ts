// A simulated set of AI providers behind one HTTP server, with the failures real ones have:
// published rate limits that answer 429 + Retry-After, limits that change without notice, outages
// (503s, or connections that hang until the client gives up), random 5xx, slow tails, 200 responses
// with truncated JSON, a response-shape change mid-flight, and scraping APIs that bill failed calls.
// It keeps its own ledger of every request, which is how the drills judge the data plane: from the
// provider's side, not from what the data plane believes it did.
import { seeded } from "./rng";
import { type GeneratedAnswer, generateAnswer, type SimProject, type Truth } from "./world";

export interface ProviderFaults {
  limitPerSecond: number; // the provider's real limit
  limitChangeAt?: { atMs: number; perSecond: number }; // the provider lowers it mid-scenario
  outages?: { fromMs: number; toMs: number; mode: "503" | "hang" }[];
  errorRate?: number; // random 500s
  latencyMs?: [number, number]; // uniform base latency
  slowRate?: number; // share of calls that take far longer than any sane timeout
  truncatedRate?: number; // 200 with a cut-off JSON body
  driftAtMs?: number; // after this, the response shape changes (openai only)
  billFailures?: boolean; // scraping providers charge for failed calls
}

export interface SimRequest {
  t: number;
  provider: string;
  runId: string;
  status: number;
  overLimit: boolean;
  billed: boolean;
  inOutage: boolean;
}

export interface Scenario {
  seed: string;
  providers: Record<string, ProviderFaults>;
  costs: Record<string, number>;
}

const PATHS: Record<string, string> = {
  "/openai/v1/chat/completions": "openai",
  "/anthropic/v1/messages": "anthropic",
  "/perplexity/chat/completions": "perplexity",
  "/gemini/v1beta/models/gemini:generateContent": "gemini",
  "/serp/search": "ai_overview",
};

export class ProviderSim {
  readonly requests: SimRequest[] = [];
  readonly truth = new Map<string, Truth>();
  readonly hooks = new Map<string, { received: Map<string, number>; failRate: number; badSignatures: number }>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private start = Date.now();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private rand: () => number;
  private prompts = new Map<string, { project: SimProject; prompt: { id: string; text: string; country: string } }>();
  private redirects = new Map<string, string>();

  constructor(
    readonly scenario: Scenario,
    projects: SimProject[],
  ) {
    this.rand = seeded(`${scenario.seed}:faults`);
    for (const p of projects) for (const q of p.prompts) this.prompts.set(q.id, { project: p, prompt: q });
  }

  get url() {
    return `http://127.0.0.1:${this.server?.port}`;
  }

  listen(port = 0) {
    this.start = Date.now();
    this.server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 30, fetch: (req) => this.handle(req) });
    return this;
  }

  stop() {
    this.server?.stop(true);
  }

  resetClock() {
    this.start = Date.now();
  }

  private elapsed() {
    return Date.now() - this.start;
  }

  /** The provider's own limiter: a token bucket refilled at its current real limit. */
  private overLimit(provider: string, f: ProviderFaults): boolean {
    const now = Date.now();
    const rate = f.limitChangeAt && this.elapsed() >= f.limitChangeAt.atMs ? f.limitChangeAt.perSecond : f.limitPerSecond;
    const b = this.buckets.get(provider) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    this.buckets.set(provider, b);
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    return false;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/grounding-api-redirect/")) {
      const to = this.redirects.get(url.pathname.split("/").pop()!);
      return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response("not found", { status: 404 });
    }
    if (url.pathname.startsWith("/__hooks/")) return this.hook(req, url.pathname.split("/").pop()!);
    const provider = PATHS[url.pathname];
    if (!provider || req.method !== "POST") return new Response("not found", { status: 404 });
    const f = this.scenario.providers[provider]!;
    const body = (await req.json()) as { prompt_id: string; run_id: string };
    const runId = req.headers.get("x-run-id") ?? body.run_id;
    const t = this.elapsed();
    const rec: SimRequest = { t, provider, runId, status: 0, overLimit: false, billed: false, inOutage: false };
    this.requests.push(rec);
    const outage = f.outages?.find((o) => t >= o.fromMs && t < o.toMs);
    if (outage) {
      rec.inOutage = true;
      if (outage.mode === "hang") {
        await Bun.sleep(30_000);
        rec.status = 504;
        return new Response("gateway timeout", { status: 504 });
      }
      rec.status = 503;
      rec.billed = !!f.billFailures;
      return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 });
    }
    if (this.overLimit(provider, f)) {
      rec.overLimit = true;
      rec.status = 429;
      return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429, headers: { "retry-after": "1" } });
    }
    const [lo, hi] = f.latencyMs ?? [20, 80];
    const slow = this.rand() < (f.slowRate ?? 0);
    await Bun.sleep(slow ? 10_000 : lo + this.rand() * (hi - lo));
    if (this.rand() < (f.errorRate ?? 0)) {
      rec.status = 500;
      rec.billed = !!f.billFailures;
      return new Response(JSON.stringify({ error: { message: "internal error" } }), { status: 500 });
    }
    const p = this.prompts.get(body.prompt_id);
    if (!p) {
      rec.status = 400;
      return new Response(JSON.stringify({ error: { message: "unknown prompt" } }), { status: 400 });
    }
    const ans = generateAnswer(p.project, p.prompt, provider, runId);
    this.truth.set(runId, ans.truth);
    rec.status = 200;
    rec.billed = true;
    let text = JSON.stringify(this.render(provider, ans, runId, f, t));
    if (this.rand() < (f.truncatedRate ?? 0)) text = text.slice(0, Math.floor(text.length * (0.3 + this.rand() * 0.5)));
    return new Response(text, {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req_${runId.slice(0, 8)}_${t}` },
    });
  }

  private render(provider: string, a: GeneratedAnswer, runId: string, f: ProviderFaults, t: number): unknown {
    const id = `${provider}-${runId.slice(0, 12)}`;
    switch (provider) {
      case "openai": {
        const drifted = f.driftAtMs !== undefined && t >= f.driftAtMs;
        const message = drifted
          ? {
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: a.text,
                  annotations: a.citations.map((c) => ({ type: "url_citation", url: c.url, title: c.title })),
                },
              ],
            }
          : {
              role: "assistant",
              content: a.text,
              annotations: a.citations.map((c) => ({ type: "url_citation", url_citation: { url: c.url, title: c.title } })),
            };
        return {
          id,
          object: "chat.completion",
          model: "gpt-search",
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: Math.ceil(a.text.length / 4) },
        };
      }
      case "anthropic": {
        const parts = a.text.split("\n");
        return {
          id,
          type: "message",
          model: "claude-search",
          content: parts.map((p, i) => ({
            type: "text",
            text: i < parts.length - 1 ? `${p}\n` : p,
            ...(i === 0
              ? { citations: a.citations.map((c) => ({ type: "web_search_result_location", url: c.url, title: c.title, cited_text: "" })) }
              : {}),
          })),
          usage: { input_tokens: 40, output_tokens: Math.ceil(a.text.length / 4) },
        };
      }
      case "perplexity":
        return {
          id,
          model: "sonar",
          choices: [{ index: 0, message: { role: "assistant", content: a.text } }],
          citations: a.citations.map((c) => c.url),
          search_results: a.citations.map((c) => ({ title: c.title, url: c.url })),
        };
      case "gemini": {
        const chunks = a.citations.map((c) => {
          const token = Bun.hash(`${runId}:${c.url}`).toString(36);
          this.redirects.set(token, c.url);
          return { web: { uri: `${this.url}/grounding-api-redirect/${token}`, title: new URL(c.url).hostname.replace(/^www\./, "") } };
        });
        return {
          candidates: [{ content: { role: "model", parts: [{ text: a.text }] }, groundingMetadata: { groundingChunks: chunks } }],
          modelVersion: "gemini-grounded",
        };
      }
      default: {
        if (!a.truth.hasAnswer) return { search_metadata: { id, status: "Success" }, ai_overview: null };
        const html = `<div data-attrid="ai-overview">${a.text
          .split("\n")
          .map((l) => `<p>${l.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/&/g, "&amp;")}</p>`)
          .join(
            "",
          )}<ul class="sources">${a.citations.map((c) => `<li><a href="${c.url.replace(/&/g, "&amp;")}">${c.title}</a></li>`).join("")}</ul></div>`;
        return { search_metadata: { id, status: "Success" }, ai_overview: { html } };
      }
    }
  }

  /** A customer's webhook endpoint that sometimes fails and checks signatures. */
  registerHook(name: string, failRate: number) {
    this.hooks.set(name, { received: new Map(), failRate, badSignatures: 0 });
    return `${this.url}/__hooks/${name}`;
  }

  hookSecret = "whsec_sim";

  private async hook(req: Request, name: string): Promise<Response> {
    const h = this.hooks.get(name);
    if (!h) return new Response("no hook", { status: 404 });
    const body = await req.text();
    const id = req.headers.get("webhook-id") ?? "";
    const ts = req.headers.get("webhook-timestamp") ?? "";
    const sig = req.headers.get("webhook-signature") ?? "";
    const expected = `v1,${new Bun.CryptoHasher("sha256", this.hookSecret).update(`${id}.${ts}.${body}`).digest("base64")}`;
    if (sig !== expected) {
      h.badSignatures++;
      return new Response("bad signature", { status: 401 });
    }
    if (this.rand() < h.failRate) return new Response("busy", { status: this.rand() < 0.5 ? 500 : 503 });
    h.received.set(id, (h.received.get(id) ?? 0) + 1);
    return new Response("ok");
  }

  stats() {
    const by: Record<string, { requests: number; overLimit: number; inOutage: number; billed: number; costEur: number; ok: number }> = {};
    for (const r of this.requests) {
      by[r.provider] ??= { requests: 0, overLimit: 0, inOutage: 0, billed: 0, costEur: 0, ok: 0 };
      const s = by[r.provider]!;
      s.requests++;
      if (r.overLimit) s.overLimit++;
      if (r.inOutage) s.inOutage++;
      if (r.status === 200) s.ok++;
      if (r.billed) {
        s.billed++;
        s.costEur += this.scenario.costs[r.provider] ?? 0;
      }
    }
    return by;
  }
}

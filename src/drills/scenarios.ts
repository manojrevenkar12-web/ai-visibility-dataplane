// The drills. Each asks one operational question and injects the faults that answer it. Times are
// compressed (a "day" of tracking runs in seconds), and limits are scaled with them.
import type { ProviderFaults } from "../sim/provider-sim";
import type { DrillSpec } from "./harness";

const PROVIDERS = ["openai", "anthropic", "perplexity", "gemini", "ai_overview"] as const;
// what each provider really allows (the simulator enforces these); config/providers.yaml matches
const LIMITS: Record<string, number> = { openai: 40, anthropic: 25, perplexity: 30, gemini: 30, ai_overview: 20 };

function faults(base: Partial<ProviderFaults>, per: Partial<Record<string, Partial<ProviderFaults>>> = {}): Record<string, ProviderFaults> {
  return Object.fromEntries(
    PROVIDERS.map((p) => [p, { limitPerSecond: LIMITS[p]!, latencyMs: [20, 120] as [number, number], ...base, ...per[p] }]),
  );
}

// drill timing: shorter leases, backoffs and cooldowns than production, same mechanisms
const FAST = {
  limits: { queue: { lease_ms: 2000, max_attempts: 8 }, worker: { max_inline_wait_ms: 250 }, webhooks: { base_ms: 100, cap_ms: 2000 } },
  providers: Object.fromEntries(
    PROVIDERS.map((p) => [
      p,
      {
        retry: { max_attempts: 5, base_ms: 100, cap_ms: 2000 },
        circuit: { window_ms: 3000, min_calls: 10, failure_rate: 0.5, cooldown_ms: 800, probes: 2 },
      },
    ]),
  ),
};

const common = {
  projects: 24,
  promptsPerProject: 25,
  workers: 3,
  workerConcurrency: 32,
  hookFailRate: 0.1,
  settings: FAST,
  timeoutMs: 240_000,
};

export const DRILLS: (DrillSpec & { baseline?: { crashAfterCallRate?: number; insertRetryDuplicateRate?: number } })[] = [
  {
    ...common,
    name: "steady",
    title: "A normal day",
    question:
      "With ordinary provider noise (1% errors, truncated bodies, a slow tail) and a webhook receiver that fails 30% of the time: is every run collected once, every event delivered, and how accurate is extraction?",
    faults: faults({ errorRate: 0.01, truncatedRate: 0.005, slowRate: 0.002 }),
    hookFailRate: 0.3,
  },
  {
    ...common,
    name: "outage",
    title: "Two providers go down",
    question:
      "Perplexity answers 503 for 4.5 s and Gemini hangs for 3 s (connections open, no answer). How much extra load do we put on providers that are down, and do runs survive the outage?",
    faults: faults(
      { errorRate: 0.01 },
      {
        perplexity: { outages: [{ fromMs: 1500, toMs: 6000, mode: "503" }] },
        gemini: { outages: [{ fromMs: 2000, toMs: 5000, mode: "hang" }] },
      },
    ),
    baseline: {},
  },
  {
    ...common,
    name: "limit_drop",
    title: "A provider lowers its rate limit without notice",
    question:
      "OpenAI's real limit drops from 40 to 12 requests per second one second in, while our configuration still says 40. How many 429s do we cause, and does work still finish?",
    faults: faults({}, { openai: { limitChangeAt: { atMs: 1000, perSecond: 12 } } }),
    baseline: {},
  },
  {
    ...common,
    name: "crash",
    title: "Workers die mid-run, the shipper dies mid-batch, Redis loses the queue",
    question:
      "3% of provider calls are followed by the worker process being killed before anything is recorded; 20% of ClickHouse batches are followed by a crash before they are marked shipped; at 3 s the queue's contents are lost (a Redis failover without the latest writes). Is any run lost or counted twice?",
    faults: faults({ errorRate: 0.005 }),
    crashAfterCallRate: 0.03,
    shipperCrashRate: 0.2,
    dropQueueAtMs: 3000,
    baseline: { crashAfterCallRate: 0.03, insertRetryDuplicateRate: 0.2 },
  },
  {
    ...common,
    name: "budget",
    title: "Projects hit their daily cost ceiling under full concurrency",
    question:
      "Half of the projects have a daily budget (€0.40) far below what their prompts cost (~€1.20). With 96 runs in flight, does any project spend more than its ceiling?",
    faults: faults({}),
    budgetEur: (i) => (i % 2 === 0 ? 0.4 : 100),
    baseline: {},
  },
  {
    ...common,
    name: "drift",
    title: "A provider changes its response format",
    question:
      "1.5 s in, the OpenAI-style API starts returning message content as typed parts (the parser for that shape is switched off, as before the fix shipped). Are the affected answers retried and paid for again, or kept and recovered once the parser is fixed?",
    faults: faults({}, { openai: { driftAtMs: 1500 } }),
    disabledParsers: ["openai.chat.v2-parts"],
    reparseAfter: true,
  },
];

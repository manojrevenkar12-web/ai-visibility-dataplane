import { describe, expect, test } from "bun:test";
import { settings } from "../../src/infra/config";
import { callProvider } from "../../src/providers/client";
import { ProviderError } from "../../src/providers/types";
import { sign, verify } from "../../src/webhooks/webhooks";

const cfg = { ...settings().providers.openai!, timeout_ms: 100 };
const input = { runId: "r1", promptId: "q1", prompt: "best crm?", country: "DE" };
const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

async function failure(f: typeof fetch): Promise<ProviderError> {
  try {
    await callProvider("http://p", cfg, input, f);
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

describe("provider client", () => {
  test("success", async () => {
    const { answer } = await callProvider(
      "http://p",
      cfg,
      input,
      respond(200, JSON.stringify({ model: "m", choices: [{ message: { content: "Hi", annotations: [] } }] }), { "x-request-id": "req1" }),
    );
    expect(answer).toMatchObject({ text: "Hi", requestId: "req1", hasAnswer: true });
  });

  test("failures are classified", async () => {
    const t = await failure(respond(429, "", { "retry-after": "3" }));
    expect([t.kind, t.retryAfterMs, t.retryable]).toEqual(["throttled", 3000, true]);
    expect((await failure(respond(503, "x"))).kind).toBe("unavailable");
    const r = await failure(respond(400, "bad"));
    expect([r.kind, r.retryable]).toEqual(["rejected", false]);
    const tr = await failure(respond(200, '{"choices":['));
    expect([tr.kind, tr.status]).toEqual(["truncated", 200]);
    const d = await failure(respond(200, JSON.stringify({ hello: 1 })));
    expect([d.kind, d.retryable, d.raw]).toEqual(["schema_drift", false, '{"hello":1}']);
  });

  test("a hung connection times out and is marked as possibly billed", async () => {
    const hang = ((_u: unknown, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const e = await failure(hang);
    expect([e.kind, e.timedOut]).toEqual(["unavailable", true]);
  });
});

describe("webhook signatures", () => {
  test("sign and verify, Standard Webhooks style", () => {
    const now = 1_790_000_000_000;
    const ts = Math.floor(now / 1000);
    const s = sign("whsec_x", "evt_1", ts, '{"a":1}');
    expect(s.startsWith("v1,")).toBe(true);
    expect(verify("whsec_x", "evt_1", ts, '{"a":1}', s, now)).toBe(true);
    expect(verify("whsec_x", "evt_1", ts, '{"a":2}', s, now)).toBe(false);
    expect(verify("whsec_y", "evt_1", ts, '{"a":1}', s, now)).toBe(false);
    expect(verify("whsec_x", "evt_1", ts, '{"a":1}', s, now + 10 * 60_000)).toBe(false); // replayed too late
    expect(verify("whsec_x", "evt_1", ts, '{"a":1}', `v1,old ${s}`, now)).toBe(true); // rotated secrets: any listed signature
  });
});

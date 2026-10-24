import { describe, expect, test } from "bun:test";
import { backoffMs, retryAfterMs } from "../../src/queue/backoff";
import { dayOf, runId, slotOf } from "../../src/runs/ids";

describe("backoff", () => {
  test("full jitter stays below the exponential ceiling and the cap", () => {
    for (let a = 1; a <= 12; a++) {
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(a, 100, 5000);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(Math.min(5000, 100 * 2 ** (a - 1)));
      }
    }
    expect(backoffMs(3, 100, 5000, () => 0.999)).toBe(399);
  });

  test("Retry-After as seconds or an HTTP date", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    const now = Date.parse("2026-10-24T10:00:00Z");
    expect(retryAfterMs("Sat, 24 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("Sat, 24 Oct 2026 09:00:00 GMT", now)).toBe(0);
  });
});

describe("run identity", () => {
  test("the same prompt, provider, country and slot always give the same id", () => {
    const slot = new Date("2026-10-24T00:00:00Z");
    expect(runId("q1", "openai", "DE", slot)).toBe(runId("q1", "openai", "DE", slot));
    expect(runId("q1", "openai", "DE", slot)).not.toBe(runId("q1", "openai", "US", slot));
    expect(runId("q1", "openai", "DE", slot)).toHaveLength(24);
  });

  test("slots align to the interval", () => {
    expect(slotOf(new Date("2026-10-24T13:47:10Z"), 1440).toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(slotOf(new Date("2026-10-24T13:47:10Z"), 60).toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(dayOf(new Date("2026-10-24T23:59:59Z"))).toBe("2026-10-24");
  });
});

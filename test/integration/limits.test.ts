import { beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/limits/budget";
import { CircuitBreaker } from "../../src/limits/circuit";
import { Semaphore } from "../../src/limits/concurrency";
import { checkFence, FencedLock } from "../../src/limits/lock";
import { RateLimiter } from "../../src/limits/rate";
import { RetryBudget } from "../../src/limits/retry-budget";
import { r, resetAll, sql } from "../helpers";

beforeEach(resetAll);

describe("rate limiter (GCRA)", () => {
  test("admits the configured rate across concurrent callers", async () => {
    const rl = new RateLimiter(r);
    const t0 = Date.now();
    let granted = 0;
    const loop = async () => {
      while (Date.now() - t0 < 2000) {
        const w = await rl.acquire("p", 20, 5);
        if (w === 0) granted++;
        else await Bun.sleep(Math.min(w, 100));
      }
    };
    await Promise.all(Array.from({ length: 50 }, loop));
    // 2 s at 20/s plus the burst of 5 (+1 for the first): a regression once let 6x through
    expect(granted).toBeGreaterThanOrEqual(38);
    expect(granted).toBeLessThanOrEqual(47);
  });

  test("a fractional wait is never reported as 0", async () => {
    const rl = new RateLimiter(r);
    const now = 1_000_000;
    expect(await rl.acquire("f", 3, 0, now)).toBe(0);
    const w = await rl.acquire("f", 3, 0, now + 333); // 0.33 ms early
    expect(w).toBeGreaterThanOrEqual(1);
  });

  test("a provider pause stops everyone", async () => {
    const rl = new RateLimiter(r);
    await rl.pause("p", Date.now() + 500);
    expect(await rl.acquire("p", 100, 10)).toBeGreaterThan(400);
  });
});

test("semaphore caps in-flight calls and frees a crashed holder's slot", async () => {
  const s = new Semaphore(r);
  expect(await s.acquire("p", 2, "a", 1000)).toBe(true);
  expect(await s.acquire("p", 2, "b", 100)).toBe(true);
  expect(await s.acquire("p", 2, "c", 1000)).toBe(false);
  await Bun.sleep(150); // b crashed without releasing
  expect(await s.acquire("p", 2, "c", 1000)).toBe(true);
  await s.release("p", "a");
  expect(await s.inFlight("p")).toBe(1);
});

test("circuit breaker opens, probes, and closes", async () => {
  const cb = new CircuitBreaker(r);
  const cfg = { window_ms: 3000, min_calls: 4, failure_rate: 0.5, cooldown_ms: 200, probes: 1 };
  const now = Date.now();
  await cb.record("p", true, cfg, now);
  for (let i = 0; i < 3; i++) await cb.record("p", false, cfg, now);
  expect(await cb.state("p")).toBe("open");
  expect(await cb.allow("p", cfg, now + 50)).toBeGreaterThan(0);
  expect(await cb.allow("p", cfg, now + 250)).toBe(0); // the probe
  expect(await cb.allow("p", cfg, now + 251)).toBeGreaterThan(0); // only one probe
  expect(await cb.record("p", false, cfg, now + 260)).toBe("open"); // failed probe
  expect(await cb.allow("p", cfg, now + 500)).toBe(0);
  expect(await cb.record("p", true, cfg, now + 510)).toBe("closed");
  expect(await cb.timesOpened("p")).toBe(1);
});

test("retry budget allows ratio x first attempts plus a floor", async () => {
  const rb = new RetryBudget(r, 10);
  const now = Date.now();
  for (let i = 0; i < 100; i++) await rb.spend("p", false, 0.2, 0, now);
  let ok = 0;
  for (let i = 0; i < 50; i++) if (await rb.spend("p", true, 0.2, 0, now)) ok++;
  expect(ok).toBe(20);
});

test("cost budget: concurrent reservations never exceed the ceiling", async () => {
  const b = new CostBudget(r);
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => b.reserve("p", "2026-10-24", 0.01, 0.5, `h${i}`, 10_000)));
  const granted = results.filter(Boolean).length;
  expect(granted).toBe(50);
  for (let i = 0; i < 200; i++) if (results[i]) await b.settle("p", "2026-10-24", `h${i}`, 0.01);
  expect(await b.spent("p", "2026-10-24")).toBeCloseTo(0.5, 6);
  expect(await b.reserve("p", "2026-10-24", 0.01, 0.5, "late", 10_000)).toBe(false);
});

test("cost budget: a crashed worker's reservation expires", async () => {
  const b = new CostBudget(r);
  expect(await b.reserve("p", "d", 0.4, 0.5, "dead", 100)).toBe(true);
  expect(await b.reserve("p", "d", 0.4, 0.5, "x", 100)).toBe(false);
  await Bun.sleep(120);
  expect(await b.reserve("p", "d", 0.4, 0.5, "x", 100)).toBe(true);
});

test("fenced lock: a deposed holder's write is refused", async () => {
  const a = new FencedLock(r, "s", "a", 100);
  const b = new FencedLock(r, "s", "b", 1000);
  const fa = await a.acquire();
  expect(fa).not.toBeNull();
  expect(await b.acquire()).toBeNull();
  await Bun.sleep(120); // a paused past its lease
  const fb = await b.acquire();
  expect(fb).toBeGreaterThan(fa!);
  expect(await sql.begin((tx) => checkFence(tx, "s", fb!))).toBe(true);
  expect(await sql.begin((tx) => checkFence(tx, "s", fa!))).toBe(false); // a wakes up and tries to act
  expect(await a.acquire()).toBeNull();
});

test("the shared rate adapts to a provider that lowered its limit (AIMD)", async () => {
  const rl = new RateLimiter(r);
  const t = 1_000_000;
  expect(await rl.throttled("a", 40, t)).toBeCloseTo(28, 6);
  expect(await rl.throttled("a", 40, t + 10)).toBeCloseTo(28, 6); // many workers, one cut per second
  expect(await rl.throttled("a", 40, t + 1000)).toBeCloseTo(19.6, 6);
  expect(await rl.effectiveRate("a", 40)).toBeCloseTo(19.6, 6);
  expect(await rl.succeeded("a", 40, t + 1500)).toBeCloseTo(19.6, 6); // not yet a second since the cut
  expect(await rl.succeeded("a", 40, t + 2000)).toBeCloseTo(21.6, 6);
  for (let i = 0; i < 20; i++) await rl.throttled("a", 40, t + 3000 + i * 1000);
  expect(await rl.effectiveRate("a", 40)).toBeCloseTo(4, 6); // floor: 10% of the ceiling
  let rate = 4;
  for (let i = 0; i < 25; i++) rate = await rl.succeeded("a", 40, t + 30_000 + i * 1000);
  expect(rate).toBe(40);
  expect(await r.exists("rl:{a}:rate")).toBe(0); // back at the ceiling, no override left
});

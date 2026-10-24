import { describe, expect, test } from "bun:test";
import { canonicalUrl } from "../../src/extract/citations";
import { generateAnswer, makeWorld } from "../../src/sim/world";

describe("simulated world", () => {
  const world = makeWorld(3, 10, "t");

  test("is deterministic", () => {
    expect(makeWorld(3, 10, "t")).toEqual(world);
    const p = world[0]!;
    expect(generateAnswer(p, p.prompts[0]!, "openai", "run-1")).toEqual(generateAnswer(p, p.prompts[0]!, "openai", "run-1"));
  });

  test("every project has one own brand, and ambiguous names exist", () => {
    for (const p of world) expect(p.brands.filter((b) => b.isOwn)).toHaveLength(1);
    expect(world.flatMap((p) => p.brands).some((b) => b.ambiguous)).toBe(true);
  });

  test("the answer key's citations are what canonicalisation should produce", () => {
    let n = 0;
    for (const p of world)
      for (const q of p.prompts) {
        const a = generateAnswer(p, q, "perplexity", `r-${q.id}`);
        const got = new Set(a.citations.map((c) => canonicalUrl(c.url)));
        for (const c of a.truth.citations) {
          expect(got.has(c)).toBe(true);
          n++;
        }
      }
    expect(n).toBeGreaterThan(30);
  });
});

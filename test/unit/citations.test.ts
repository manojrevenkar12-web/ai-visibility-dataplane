import { describe, expect, test } from "bun:test";
import { canonicalUrl, domainOf, resolveRedirect, sourceType } from "../../src/extract/citations";

describe("canonical URLs", () => {
  test.each([
    ["https://www.g2.com/compare/x?utm_source=chatgpt.com", "https://g2.com/compare/x"],
    ["https://m.taskwise.com/pricing/", "https://taskwise.com/pricing"],
    ["http://WWW.Taskwise.com/pricing/amp#plans", "https://taskwise.com/pricing"],
    ["https://reddit.com/r/x?srsltid=abc&b=2&a=1", "https://reddit.com/r/x?a=1&b=2"],
    ["https://taskwise.com/", "https://taskwise.com"],
    ["https://taskwise.com/blog/index.html", "https://taskwise.com/blog"],
    ["https://www.google.com/url?q=https%3A%2F%2Fwww.capterra.com%2Fp%2F1%3Futm_medium%3Dx", "https://capterra.com/p/1"],
  ])("%s", (raw, want) => {
    expect(canonicalUrl(raw)).toBe(want);
  });

  test("not a web URL", () => {
    expect(canonicalUrl("mailto:x@y.z")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
  });

  test("domains and source types", () => {
    expect(domainOf("https://blog.taskwise.com/x")).toBe("taskwise.com");
    expect(domainOf("https://shop.example.co.uk/x")).toBe("example.co.uk");
    const brands = { own: new Set(["taskwise.com"]), competitor: new Set(["planora.de"]) };
    expect(sourceType("taskwise.com", brands)).toBe("own");
    expect(sourceType("planora.de", brands)).toBe("competitor");
    expect(sourceType("g2.com", brands)).toBe("review");
    expect(sourceType("reddit.com", brands)).toBe("ugc");
    expect(sourceType("example.org", brands)).toBe("other");
  });

  test("grounding redirects are resolved once and cached", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://g2.com/x" } });
    }) as unknown as typeof fetch;
    const cache = new Map<string, string>();
    const u = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    expect(await resolveRedirect(u, cache, fake)).toBe("https://g2.com/x");
    expect(await resolveRedirect(u, cache, fake)).toBe("https://g2.com/x");
    expect(calls).toBe(1);
    expect(await resolveRedirect("https://g2.com/y", cache, fake)).toBe("https://g2.com/y");
  });
});

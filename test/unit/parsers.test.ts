import { describe, expect, test } from "bun:test";
import { disabledParsers, parseBody, readHtml, shape } from "../../src/providers/parsers";

const ok = (format: string, body: unknown) => {
  const r = parseBody(format, JSON.stringify(body));
  if (!r.ok) throw new Error(r.detail);
  return r.answer;
};

describe("provider parsers", () => {
  test("openai chat with url citations", () => {
    const a = ok("openai", {
      model: "m",
      choices: [
        {
          message: {
            content: "Hi",
            annotations: [{ type: "url_citation", url_citation: { url: "https://a.com", title: "A" } }, { type: "other" }],
          },
        },
      ],
    });
    expect(a).toMatchObject({ text: "Hi", citations: [{ url: "https://a.com", title: "A" }], parser: "openai.chat.v1" });
  });

  test("openai content parts (the drifted shape)", () => {
    const body = {
      choices: [{ message: { content: [{ type: "output_text", text: "Hi", annotations: [{ url: "https://b.com", title: "B" }] }] } }],
    };
    expect(ok("openai", body).parser).toBe("openai.chat.v2-parts");
    disabledParsers.add("openai.chat.v2-parts");
    try {
      const r = parseBody("openai", JSON.stringify(body));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("schema_drift");
    } finally {
      disabledParsers.delete("openai.chat.v2-parts");
    }
  });

  test("anthropic, perplexity, gemini", () => {
    expect(
      ok("anthropic", {
        type: "message",
        model: "c",
        content: [
          { type: "text", text: "A ", citations: [{ url: "https://x.com" }] },
          { type: "text", text: "B" },
        ],
      }),
    ).toMatchObject({ text: "A B", citations: [{ url: "https://x.com" }] });
    expect(ok("perplexity", { choices: [{ message: { content: "P" } }], citations: ["https://p.com"] }).citations).toEqual([
      { url: "https://p.com" },
    ]);
    expect(
      ok("perplexity", {
        choices: [{ message: { content: "P" } }],
        citations: ["https://p.com"],
        search_results: [{ url: "https://q.com", title: "Q" }],
      }).citations,
    ).toEqual([{ url: "https://q.com", title: "Q" }]);
    expect(
      ok("gemini", {
        candidates: [
          {
            content: { parts: [{ text: "G" }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://r/1", title: "g2.com" } }] },
          },
        ],
      }).citations,
    ).toEqual([{ url: "https://r/1", title: "g2.com" }]);
  });

  test("AI Overview HTML, and no overview at all", () => {
    const a = ok("aio_html", {
      search_metadata: { id: "1" },
      ai_overview: {
        html: '<div><p>1. <strong>Taskwise</strong> &amp; more</p><p>Two</p><ul class="sources"><li><a href="https://a.com/?x=1&amp;y=2">A site</a></li></ul></div>',
      },
    });
    expect(a.text).toBe("1. **Taskwise** & more\nTwo");
    expect(a.citations).toEqual([{ url: "https://a.com/?x=1&y=2", title: "A site" }]);
    expect(ok("aio_html", { search_metadata: { id: "1" }, ai_overview: null }).hasAnswer).toBe(false);
    expect(readHtml("<p>x</p>").links).toEqual([]);
  });

  test("truncated JSON is retryable; an unknown shape is drift", () => {
    const t = parseBody("openai", '{"choices":[{"message":{"content":"Hi');
    expect(t.ok || t.kind).toBe("truncated");
    const d = parseBody("anthropic", JSON.stringify({ type: "msg", parts: [] }));
    expect(d.ok || d.kind).toBe("schema_drift");
    expect(shape({ a: [{ b: 1 }], c: "x" })).toBe("{a:[{b:number}],c:string}");
  });
});

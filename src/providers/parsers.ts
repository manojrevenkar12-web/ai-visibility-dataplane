// Parsers per response format. Each parser either recognises the shape it was written for or
// returns null; a body no parser recognises is schema drift. The raw body of a drifted response is
// kept, so after a parser fix the run is completed from it without calling (and paying) again.
import type { Citation, ProviderAnswer } from "./types";

type Json = Record<string, unknown>;
type Parser = { name: string; parse: (j: Json) => Omit<ProviderAnswer, "parser" | "requestId"> | null };

const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

const openaiV1: Parser = {
  name: "openai.chat.v1",
  parse(j) {
    const msg = (arr(j.choices)[0] as Json | undefined)?.message;
    if (!isObj(msg) || typeof msg.content !== "string") return null;
    const citations: Citation[] = arr(msg.annotations)
      .filter(isObj)
      .flatMap((a): Citation[] =>
        isObj(a.url_citation) && str(a.url_citation.url)
          ? [{ url: str(a.url_citation.url)!, title: str(a.url_citation.title) ?? undefined }]
          : [],
      );
    return { text: msg.content, citations, model: str(j.model) ?? "unknown", hasAnswer: true };
  },
};

/** The shape OpenAI-style APIs moved to: content as typed parts with inline annotations. */
const openaiV2: Parser = {
  name: "openai.chat.v2-parts",
  parse(j) {
    const msg = (arr(j.choices)[0] as Json | undefined)?.message;
    if (!isObj(msg) || !Array.isArray(msg.content)) return null;
    const parts = msg.content.filter(isObj).filter((p) => p.type === "output_text" || p.type === "text");
    if (!parts.length) return null;
    const citations = parts
      .flatMap((p) => arr(p.annotations))
      .filter(isObj)
      .map((a) => ({ url: str(a.url) ?? str((a.url_citation as Json | undefined)?.url) ?? "", title: str(a.title) ?? undefined }))
      .filter((c) => c.url);
    return { text: parts.map((p) => str(p.text) ?? "").join(""), citations, model: str(j.model) ?? "unknown", hasAnswer: true };
  },
};

const anthropicV1: Parser = {
  name: "anthropic.messages.v1",
  parse(j) {
    if (j.type !== "message" || !Array.isArray(j.content)) return null;
    const blocks = j.content.filter(isObj).filter((b) => b.type === "text");
    const citations = blocks
      .flatMap((b) => arr(b.citations))
      .filter(isObj)
      .map((c) => ({ url: str(c.url) ?? "", title: str(c.title) ?? undefined }))
      .filter((c) => c.url);
    return { text: blocks.map((b) => str(b.text) ?? "").join(""), citations, model: str(j.model) ?? "unknown", hasAnswer: true };
  },
};

const perplexityV1: Parser = {
  name: "perplexity.sonar.v1",
  parse(j) {
    const msg = (arr(j.choices)[0] as Json | undefined)?.message;
    if (!isObj(msg) || typeof msg.content !== "string") return null;
    const fromResults = arr(j.search_results)
      .filter(isObj)
      .map((r) => ({ url: str(r.url) ?? "", title: str(r.title) ?? undefined }));
    const citations = fromResults.length ? fromResults : arr(j.citations).map((u) => ({ url: str(u) ?? "" }));
    return { text: msg.content, citations: citations.filter((c) => c.url), model: str(j.model) ?? "sonar", hasAnswer: true };
  },
};

const geminiV1: Parser = {
  name: "gemini.generate.v1",
  parse(j) {
    const cand = arr(j.candidates)[0];
    if (!isObj(cand) || !isObj(cand.content)) return null;
    const text = arr(cand.content.parts)
      .filter(isObj)
      .map((p) => str(p.text) ?? "")
      .join("");
    const meta = isObj(cand.groundingMetadata) ? cand.groundingMetadata : {};
    const citations = arr(meta.groundingChunks)
      .filter(isObj)
      .flatMap((c): Citation[] => (isObj(c.web) && str(c.web.uri) ? [{ url: str(c.web.uri)!, title: str(c.web.title) ?? undefined }] : []));
    return { text, citations, model: str(j.modelVersion) ?? "gemini", hasAnswer: true };
  },
};

const aioHtmlV1: Parser = {
  name: "serp.aio-html.v1",
  parse(j) {
    if (!isObj(j.search_metadata)) return null;
    if (j.ai_overview === null || j.ai_overview === undefined) return { text: "", citations: [], model: "ai-overview", hasAnswer: false };
    if (!isObj(j.ai_overview) || typeof j.ai_overview.html !== "string") return null;
    const { text, links } = readHtml(j.ai_overview.html);
    return { text, citations: links, model: "ai-overview", hasAnswer: true };
  },
};

/** Text (with <strong> kept as **bold**, which mention detection uses) and links from an AI Overview block. */
export function readHtml(html: string): { text: string; links: Citation[] } {
  const paras: string[] = [];
  const links: Citation[] = [];
  let cur: string[] | null = null;
  let inSources = false;
  let link: Citation | null = null;
  new HTMLRewriter()
    .on("p", {
      element(el) {
        cur = [];
        el.onEndTag(() => {
          if (cur) paras.push(cur.join("").trim());
          cur = null;
        });
      },
    })
    .on("strong", {
      element(el) {
        cur?.push("**");
        el.onEndTag(() => {
          cur?.push("**");
        });
      },
    })
    .on("ul.sources", {
      element(el) {
        inSources = true;
        el.onEndTag(() => {
          inSources = false;
        });
      },
    })
    .on("a", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href) return;
        link = { url: href.replace(/&amp;/g, "&"), title: "" };
        links.push(link);
        el.onEndTag(() => {
          link = null;
        });
      },
    })
    .onDocument({
      text(t) {
        if (link && inSources) link.title = `${link.title ?? ""}${t.text}`;
        else if (cur) cur.push(t.text);
      },
    })
    .transform(html);
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  return { text: paras.map(decode).join("\n"), links };
}

export const PARSERS: Record<string, Parser[]> = {
  openai: [openaiV1, openaiV2],
  anthropic: [anthropicV1],
  perplexity: [perplexityV1],
  gemini: [geminiV1],
  aio_html: [aioHtmlV1],
};

/** Parsers switched off, by name. Used to replay what the system did before a parser existed. */
export const disabledParsers = new Set<string>((process.env.DISABLED_PARSERS ?? "").split(",").filter(Boolean));

export type ParseResult =
  | { ok: true; answer: Omit<ProviderAnswer, "requestId"> }
  | { ok: false; kind: "truncated" | "schema_drift"; detail: string };

export function parseBody(format: string, body: string): ParseResult {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch (e) {
    return { ok: false, kind: "truncated", detail: `invalid JSON (${(e as Error).message.slice(0, 80)}), ${body.length} bytes` };
  }
  if (!isObj(j)) return { ok: false, kind: "schema_drift", detail: "body is not an object" };
  for (const p of PARSERS[format] ?? []) {
    if (disabledParsers.has(p.name)) continue;
    const r = p.parse(j);
    if (r) return { ok: true, answer: { ...r, parser: p.name } };
  }
  return { ok: false, kind: "schema_drift", detail: `no ${format} parser recognises keys ${shape(j)}` };
}

/** A compact description of a JSON shape for the quarantine record and the alert. */
export function shape(j: unknown, depth = 0): string {
  if (Array.isArray(j)) return `[${j.length ? shape(j[0], depth + 1) : ""}]`;
  if (isObj(j) && depth < 3)
    return `{${Object.keys(j)
      .sort()
      .map((k) => `${k}:${shape(j[k], depth + 1)}`)
      .join(",")}}`;
  return typeof j;
}

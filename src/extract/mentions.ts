// Brand mentions and their position in the answer.
//
// A brand is mentioned when its name or an alias occurs as a whole word (case-insensitive, with
// possessives and German inflection tolerated). Some brand names are ordinary words ("Atlas",
// "Signal"); for those an occurrence only counts with evidence that the brand is meant: written
// with a capital inside a sentence, set in bold, used as a list item, written as an alias, or
// opening a sentence in an answer that also cites the brand's own site. Position is the order of
// first mention among the tracked brands (1 = named first).

export interface BrandRef {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
  ambiguous: boolean;
}

export interface Mention {
  brandId: string;
  position: number;
  offset: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matcher(term: string, caseSensitive: boolean): RegExp {
  // word boundary that understands umlauts and digits; allow 's / ’s / s (German genitive) after it
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?:['’]s|s)?(?![\\p{L}\\p{N}])`, caseSensitive ? "gu" : "giu");
}

function sentenceStart(text: string, i: number): boolean {
  const before = text.slice(0, i).replace(/[*_\s]+$/, "");
  return before === "" || /[.!?:\n]$/.test(before) || /(^|\n)\s*(\d+[.)]|[-*•])$/.test(before);
}

function inBold(text: string, i: number, len: number): boolean {
  return text.slice(Math.max(0, i - 2), i) === "**" && text.slice(i + len, i + len + 6).match(/^(['’]s|s)?\*\*/) !== null;
}

function listItem(text: string, i: number): boolean {
  const lineStart = text.lastIndexOf("\n", i - 1) + 1;
  return /^\s*(\d+[.)]|[-*•])\s*(\*\*)?$/.test(text.slice(lineStart, i));
}

/** URLs are blanked (same length, so offsets stay valid): a brand that appears only inside a link is not mentioned. */
export function blankUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)[^\s)\]>"']+/gi, (u) => " ".repeat(u.length));
}

export function findMentions(rawText: string, brands: BrandRef[], citedDomains: Set<string>): Mention[] {
  const text = blankUrls(rawText);
  const first: { brandId: string; offset: number }[] = [];
  for (const b of brands) {
    let best = -1;
    // aliases first: "Orbit Projects" is unambiguous even when "Orbit" is not
    for (const alias of b.aliases) {
      const m = matcher(alias, false).exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    const re = matcher(b.name, b.ambiguous);
    for (const m of text.matchAll(re)) {
      const i = m.index!;
      if (best >= 0 && i >= best) break;
      if (!b.ambiguous) {
        best = i;
        break;
      }
      const strong = inBold(text, i, m[0].length) || listItem(text, i);
      const midSentence = !sentenceStart(text, i);
      const ownSiteCited = b.domains.some((d) => citedDomains.has(d));
      if (strong || midSentence || ownSiteCited) {
        best = i;
        break;
      }
    }
    if (best >= 0) first.push({ brandId: b.id, offset: best });
  }
  first.sort((a, b) => a.offset - b.offset);
  return first.map((f, k) => ({ brandId: f.brandId, offset: f.offset, position: k + 1 }));
}

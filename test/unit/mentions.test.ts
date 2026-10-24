import { describe, expect, test } from "bun:test";
import { type BrandRef, findMentions } from "../../src/extract/mentions";

const B = (id: string, name: string, extra: Partial<BrandRef> = {}): BrandRef => ({
  id,
  name,
  aliases: [],
  domains: [`${id}.com`],
  ambiguous: false,
  ...extra,
});
const brands = [
  B("tw", "Taskwise"),
  B("pl", "Planora"),
  B("or", "Orbit", { ambiguous: true, aliases: ["Orbit Projects"] }),
  B("ku", "Kundo"),
  B("fi", "Finom24", { aliases: ["Finom 24"] }),
];
const ids = (text: string, cited: string[] = []) => findMentions(text, brands, new Set(cited)).map((m) => `${m.brandId}@${m.position}`);

describe("brand mentions", () => {
  test("names, aliases, possessives, case", () => {
    expect(ids("Try Planora first, then taskwise.")).toEqual(["pl@1", "tw@2"]);
    expect(ids("Taskwise’s onboarding is quick. Finom 24 is a bank.")).toEqual(["tw@1", "fi@2"]);
  });

  test("whole words only, including umlauts", () => {
    expect(ids("Kundorf is a village; Kundo is a CRM.")).toEqual(["ku@1"]);
    expect(ids("Taskwiseö is not a brand")).toEqual([]);
  });

  test("an ambiguous name needs evidence that the brand is meant", () => {
    expect(ids("Keep every workstream in orbit around one roadmap.")).toEqual([]);
    expect(ids("Orbit quality matters more than volume.")).toEqual([]); // sentence start, no other signal
    expect(ids("Also, Orbit is easy to roll out.")).toEqual(["or@1"]); // capitalised mid-sentence
    expect(ids("1. **Orbit** – easy to roll out.")).toEqual(["or@1"]); // bold list item
    expect(ids("Orbit Projects is easy to roll out.")).toEqual(["or@1"]); // alias
    expect(ids("Orbit is easy to roll out.", ["or.com"])).toEqual(["or@1"]); // its own site is cited
  });

  test("position is the order of first mention", () => {
    expect(ids("Kundo, then Taskwise. Kundo again, and Planora.")).toEqual(["ku@1", "tw@2", "pl@3"]);
  });
});

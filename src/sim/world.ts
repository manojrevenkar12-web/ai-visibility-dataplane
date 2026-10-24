// A simulated market: projects (customers) tracking their brand and competitors in a category,
// the prompts they track, and the answers each AI surface gives. Brand names are invented; some are
// ordinary words ("Atlas", "Orbit", "Signal") because real brand lists are full of those, and the
// answers use those words in their ordinary sense too. The generator records what it really
// mentioned and cited, which is the answer key for extraction.
import { pick, seeded, shuffle } from "./rng";

export interface SimBrand {
  id: string;
  name: string;
  aliases: string[];
  domain: string;
  ambiguous: boolean;
  isOwn: boolean;
}

export interface SimProject {
  id: string;
  name: string;
  category: string;
  brands: SimBrand[];
  prompts: { id: string; text: string; country: string }[];
}

const CATEGORIES: { key: string; de: string; en: string; brands: [string, string[], boolean][]; topics: [string, string][] }[] = [
  {
    key: "pm",
    en: "project management tools",
    de: "Projektmanagement-Tools",
    brands: [
      ["Taskwise", ["Taskwise PM"], false],
      ["Planora", [], false],
      ["Orbit", ["Orbit Projects"], true],
      ["Kanbo", [], false],
      ["Atlas", ["Atlas Work OS"], true],
      ["Teamflow", [], false],
    ],
    topics: [
      ["for agencies", "für Agenturen"],
      ["for remote teams", "für Remote-Teams"],
      ["with Gantt charts", "mit Gantt-Diagramm"],
      ["that are GDPR compliant", "DSGVO-konform"],
      ["for construction firms", "für Baufirmen"],
      ["with time tracking", "mit Zeiterfassung"],
    ],
  },
  {
    key: "crm",
    en: "CRM software for SMEs",
    de: "CRM-Software für den Mittelstand",
    brands: [
      ["Pipewell", [], false],
      ["Nordlicht CRM", ["Nordlicht"], false],
      ["Signal", ["Signal CRM"], true],
      ["Kundo", [], false],
      ["Leadbird", [], false],
      ["Pilot", ["Pilot Sales"], true],
    ],
    topics: [
      ["with email integration", "mit E-Mail-Integration"],
      ["hosted in Germany", "mit Hosting in Deutschland"],
      ["for B2B sales", "für den B2B-Vertrieb"],
      ["with a free plan", "mit kostenlosem Tarif"],
      ["for startups", "für Startups"],
      ["with DATEV export", "mit DATEV-Export"],
    ],
  },
  {
    key: "bank",
    en: "business bank accounts",
    de: "Geschäftskonten",
    brands: [
      ["Klarbank", [], false],
      ["Finom24", ["Finom 24"], false],
      ["Ledger", ["Ledger Business"], true],
      ["Vaulto", [], false],
      ["Sparwerk", [], false],
    ],
    topics: [
      ["for freelancers", "für Freiberufler"],
      ["for GmbHs", "für eine GmbH"],
      ["with virtual cards", "mit virtuellen Karten"],
      ["without monthly fees", "ohne Kontoführungsgebühr"],
      ["for e-commerce", "für Onlinehändler"],
      ["with accounting integration", "mit Buchhaltungsanbindung"],
    ],
  },
];

const DISTRACTORS: Record<string, string[]> = {
  Orbit: ["Keep every workstream in orbit around one roadmap.", "Some teams prefer an orbit of small, focused tools."],
  Atlas: ["Think of the backlog as an atlas of everything the team owes.", "No single tool is an atlas for every workflow."],
  Signal: ["Signal quality from your pipeline matters more than volume.", "Look for a strong signal in the data before switching."],
  Pilot: ["Run a pilot with two teams before rolling out.", "Pilot projects reduce the risk of a bad fit."],
  Ledger: ["Keep a clean ledger of every transaction for your tax advisor.", "Ledger exports matter if your accountant uses DATEV."],
};

const SOURCES = [
  "g2.com",
  "capterra.com",
  "reddit.com",
  "youtube.com",
  "trustpilot.com",
  "t3n.de",
  "zapier.com",
  "omr.com",
  "wikipedia.org",
  "heise.de",
  "medium.com",
];

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function makeWorld(nProjects: number, promptsPerProject: number, seed = "world"): SimProject[] {
  const rand = seeded(seed);
  const out: SimProject[] = [];
  for (let p = 0; p < nProjects; p++) {
    const cat = CATEGORIES[p % CATEGORIES.length]!;
    const own = p % cat.brands.length;
    const pid = `p${String(p + 1).padStart(3, "0")}`;
    const brands: SimBrand[] = cat.brands.map(([name, aliases, ambiguous], i) => ({
      id: `${pid}-b${i}`,
      name,
      aliases,
      domain: `${slug(name)}.${i % 2 ? "de" : "com"}`,
      ambiguous,
      isOwn: i === own,
    }));
    const prompts = [];
    for (let i = 0; i < promptsPerProject; i++) {
      const de = rand() < 0.5;
      const topic = pick(rand, cat.topics);
      const text = de
        ? pick(rand, [`Welche ${cat.de} sind die besten ${topic}?`, `Beste ${cat.de} ${topic} 2026`, `Vergleich: ${cat.de} ${topic}`])
        : pick(rand, [
            `What are the best ${cat.en} ${topic}?`,
            `Top ${cat.en} ${topic} in 2026`,
            `Which ${cat.en} should I choose ${topic}?`,
          ]);
      prompts.push({ id: `${pid}-q${String(i + 1).padStart(3, "0")}`, text, country: de ? "DE" : "US" });
    }
    out.push({ id: pid, name: `${brands[own]!.name} (customer ${p + 1})`, category: cat.key, brands, prompts });
  }
  return out;
}

export interface Truth {
  runId: string;
  mentioned: string[]; // brand ids in order of first mention
  citations: string[]; // canonical URLs in order
  hasAnswer: boolean;
}

export interface GeneratedAnswer {
  text: string;
  citations: { url: string; title: string }[];
  truth: Truth;
}

/** URL variants real answers carry: tracking parameters, www/m./amp, trailing slashes, fragments. */
function noisyUrl(rand: () => number, canonical: string): string {
  const u = new URL(canonical);
  const r = rand();
  if (r < 0.2) u.searchParams.set("utm_source", pick(rand, ["chatgpt.com", "perplexity", "openai"]));
  else if (r < 0.3) u.searchParams.set("srsltid", Math.floor(rand() * 1e9).toString(36));
  if (rand() < 0.25) u.hostname = `www.${u.hostname}`;
  else if (rand() < 0.06) u.hostname = `m.${u.hostname}`;
  if (rand() < 0.15 && !u.pathname.endsWith("/")) u.pathname += "/";
  if (rand() < 0.05) u.pathname += u.pathname.endsWith("/") ? "amp" : "/amp";
  if (rand() < 0.08) u.hash = "pricing";
  return u.toString();
}

export function generateAnswer(
  project: SimProject,
  prompt: { id: string; text: string; country: string },
  provider: string,
  runId: string,
): GeneratedAnswer {
  const rand = seeded(`${runId}`);
  const de = prompt.country === "DE";
  if (provider === "ai_overview" && rand() < 0.15) {
    return { text: "", citations: [], truth: { runId, mentioned: [], citations: [], hasAnswer: false } }; // no AI Overview for this query
  }
  // provider-specific taste: each surface favours a different slice of the market
  const bias = seeded(`${project.id}:${provider}`);
  const weights = project.brands.map((b) => (b.isOwn ? 0.45 : 0.3) + bias() * 0.6);
  const chosen = shuffle(rand, project.brands)
    .filter((b) => rand() < weights[project.brands.indexOf(b)]!)
    .slice(0, 5);
  chosen.sort((a, b) => weights[project.brands.indexOf(b)]! - weights[project.brands.indexOf(a)]! + (rand() - 0.5) * 0.4);
  const lines: string[] = [];
  const intro = de
    ? `Hier sind empfehlenswerte Optionen für „${prompt.text.replace(/\?$/, "")}“:`
    : `Here are strong options for "${prompt.text.replace(/\?$/, "")}":`;
  lines.push(intro);
  const list = rand() < 0.6;
  const cites: { url: string; title: string }[] = [];
  const truthCites: string[] = [];
  chosen.forEach((b, i) => {
    const name = b.aliases.length && rand() < 0.3 ? pick(rand, b.aliases) : b.name;
    const variant = rand();
    // English possessives; German has no apostrophe genitive here, so only in English answers
    const shown = !de && variant < 0.1 ? `${name}’s` : !de && variant < 0.15 ? `${name}'s` : name;
    const why = de
      ? pick(rand, [
          "überzeugt mit einfacher Bedienung",
          "bietet Hosting in der EU",
          "hat ein faires Preismodell",
          "integriert sich gut in bestehende Tools",
        ])
      : shown !== name
        ? pick(rand, ["onboarding is quick", "EU hosting is a plus", "pricing is easy to understand"])
        : pick(rand, ["is easy to roll out", "offers EU hosting", "has fair pricing", "integrates well with existing tools"]);
    if (list) lines.push(`${i + 1}. **${shown}** – ${why}.`);
    else lines.push(`${i === 0 ? "" : de ? "Außerdem " : "Also, "}${shown} ${why}.`);
    if (rand() < 0.5) {
      const canonical = `https://${b.domain}/${pick(rand, ["pricing", "features", "", "blog/comparison"])}`.replace(/\/$/, "");
      const url = noisyUrl(rand, canonical);
      cites.push({ url, title: `${b.name} – ${de ? "Funktionen" : "Features"}` });
      truthCites.push(canonical);
    }
  });
  // ordinary-word uses of ambiguous brand names, which are not mentions
  for (const b of project.brands) {
    const d = DISTRACTORS[b.name];
    if (d && rand() < 0.35) lines.splice(1 + Math.floor(rand() * (lines.length - 1)), 0, pick(rand, d));
  }
  const nSources = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < nSources; i++) {
    const dom = pick(rand, SOURCES);
    const canonical = `https://${dom}/${slugPath(rand, project.category)}`;
    if (truthCites.includes(canonical)) continue;
    cites.push({ url: noisyUrl(rand, canonical), title: `${dom} review` });
    truthCites.push(canonical);
  }
  if (!chosen.length)
    lines.push(
      de ? "Keine klare Empfehlung; es hängt vom Anwendungsfall ab." : "There is no single best choice; it depends on the use case.",
    );
  return {
    text: lines.join("\n"),
    citations: cites,
    truth: { runId, mentioned: chosen.map((b) => b.id), citations: truthCites, hasAnswer: true },
  };
}

function slugPath(rand: () => number, category: string) {
  return `${pick(rand, ["best", "top", "compare", "reviews"])}-${category}-${Math.floor(rand() * 40)}`;
}

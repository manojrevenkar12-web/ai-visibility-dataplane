// bun run src/cmd/heldout.ts [set] — score extraction on answers written blind (heldout/<set>/answers.yaml).
// The first run of a set is written to reports/heldout/<set>/first_run.json and FIRST_RUN.md and
// never overwritten; later runs go to latest.json. If the extraction code is changed after studying a
// set's failures, the set becomes a regression set (heldout/<set>/STATUS) and a new one is written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, domainOf } from "../extract/citations";
import { type BrandRef, findMentions } from "../extract/mentions";
import { ROOT } from "../infra/config";

interface Set {
  projects: { id: string; brands: { id: string; name: string; aliases?: string[]; domains?: string[]; ambiguous?: boolean }[] }[];
  answers: {
    id: string;
    project: string;
    provider: string;
    language: string;
    text: string;
    citations?: string[];
    key: { mentioned: string[]; pages: string[] };
  }[];
}

const set = process.argv[2] ?? "v1";
const data = Bun.YAML.parse(readFileSync(join(ROOT, "heldout", set, "answers.yaml"), "utf8")) as Set;
const brandsBy = new Map(
  data.projects.map((p) => [
    p.id,
    p.brands.map(
      (b): BrandRef => ({ id: b.id, name: b.name, aliases: b.aliases ?? [], domains: b.domains ?? [], ambiguous: !!b.ambiguous }),
    ),
  ]),
);
let tp = 0;
let fp = 0;
let fn = 0;
let orderOk = 0;
let orderN = 0;
let ctp = 0;
let cfp = 0;
let cfn = 0;
const errors: {
  id: string;
  provider: string;
  language: string;
  missed: string[];
  extra: string[];
  order?: { want: string[]; got: string[] };
  pages_missed: string[];
  pages_extra: string[];
}[] = [];
const by: Record<string, { tp: number; fp: number; fn: number }> = {};
for (const a of data.answers) {
  const brands = brandsBy.get(a.project) ?? [];
  const pages = [...new Set((a.citations ?? []).map((u) => canonicalUrl(u)).filter((u): u is string => !!u))];
  const got = findMentions(a.text, brands, new Set(pages.map(domainOf))).map((m) => m.brandId);
  const want = a.key.mentioned;
  const missed = want.filter((b) => !got.includes(b));
  const extra = got.filter((b) => !want.includes(b));
  const t = want.length - missed.length;
  tp += t;
  fp += extra.length;
  fn += missed.length;
  const k = `${a.language}`;
  by[k] ??= { tp: 0, fp: 0, fn: 0 };
  by[k].tp += t;
  by[k].fp += extra.length;
  by[k].fn += missed.length;
  const common = got.filter((b) => want.includes(b));
  const wantCommon = want.filter((b) => got.includes(b));
  if (common.length > 1) {
    orderN++;
    if (common.join() === wantCommon.join()) orderOk++;
  }
  const wantPages = new Set(a.key.pages);
  const pm = [...wantPages].filter((p) => !pages.includes(p));
  const pe = pages.filter((p) => !wantPages.has(p));
  ctp += pages.length - pe.length;
  cfp += pe.length;
  cfn += pm.length;
  if (missed.length || extra.length || pm.length || pe.length || (common.length > 1 && common.join() !== wantCommon.join())) {
    errors.push({
      id: a.id,
      provider: a.provider,
      language: a.language,
      missed,
      extra,
      ...(common.join() !== wantCommon.join() ? { order: { want: wantCommon, got: common } } : {}),
      pages_missed: pm,
      pages_extra: pe,
    });
  }
}
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const res = {
  set,
  ran_at: new Date().toISOString(),
  answers: data.answers.length,
  mentions: {
    precision: r4(tp / Math.max(1, tp + fp)),
    recall: r4(tp / Math.max(1, tp + fn)),
    tp,
    fp,
    fn,
    order_exact: r4(orderOk / Math.max(1, orderN)),
    by_language: by,
  },
  pages: { precision: r4(ctp / Math.max(1, ctp + cfp)), recall: r4(ctp / Math.max(1, ctp + cfn)), tp: ctp, fp: cfp, fn: cfn },
  errors,
};
const dir = join(ROOT, "reports", "heldout", set);
mkdirSync(dir, { recursive: true });
const first = join(dir, "first_run.json");
const target = existsSync(first) ? join(dir, "latest.json") : first;
writeFileSync(target, JSON.stringify(res, null, 1));
if (target === first) {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const L = [
    `# Held-out answers ${set}: first run`,
    "",
    `Run once on ${res.ran_at}. The ${res.answers} answers and their answer key were written by an agent that read only`,
    "`heldout/WRITING_ANSWERS.md`, never the code. This file is not regenerated; later runs go to `latest.json`.",
    "",
    `- Brand mentions: precision **${pct(res.mentions.precision)}**, recall **${pct(res.mentions.recall)}** (${tp} found, ${fp} false, ${fn} missed); order of first mention exact in ${pct(res.mentions.order_exact)} of answers with two or more brands found.`,
    `- Cited pages: precision **${pct(res.pages.precision)}**, recall **${pct(res.pages.recall)}** (${ctp} found, ${cfp} extra, ${cfn} missed).`,
    "",
    "| Language | Found | False | Missed |",
    "|---|---|---|---|",
    ...Object.entries(by).map(([k, v]) => `| ${k} | ${v.tp} | ${v.fp} | ${v.fn} |`),
    "",
    "## Errors",
    "",
    ...errors.map(
      (e) =>
        `- ${e.id} (${e.provider}, ${e.language}):${e.missed.length ? ` missed ${e.missed.join(", ")};` : ""}${e.extra.length ? ` false ${e.extra.join(", ")};` : ""}${e.order ? ` order ${e.order.got.join(" > ")} (want ${e.order.want.join(" > ")});` : ""}${e.pages_missed.length ? ` pages missed ${e.pages_missed.join(" ")};` : ""}${e.pages_extra.length ? ` pages extra ${e.pages_extra.join(" ")}` : ""}`,
    ),
  ];
  writeFileSync(join(dir, "FIRST_RUN.md"), `${L.join("\n")}\n`);
}
console.log(
  `[heldout ${set}] mentions P ${res.mentions.precision} R ${res.mentions.recall}; pages P ${res.pages.precision} R ${res.pages.recall} -> ${target.replace(`${ROOT}/`, "")}`,
);

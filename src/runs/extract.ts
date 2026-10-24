// From a provider answer to the analytics rows: canonical citations with their source type, and
// for every tracked brand whether and where it was mentioned.
import { canonicalUrl, domainOf, resolveRedirect, sourceType } from "../extract/citations";
import { findMentions } from "../extract/mentions";
import type { ProviderAnswer } from "../providers/types";
import type { ProjectInfo } from "./store";
import type { AnalyticsPayload, RunJob } from "./types";

const redirectCache = new Map<string, string>();

export async function toAnalytics(
  job: RunJob,
  project: ProjectInfo,
  answer: ProviderAnswer,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalyticsPayload> {
  const own = new Set(project.brands.filter((b) => b.isOwn).flatMap((b) => b.domains));
  const competitor = new Set(project.brands.filter((b) => !b.isOwn).flatMap((b) => b.domains));
  const seen = new Set<string>();
  const citations: AnalyticsPayload["citations"] = [];
  for (const c of answer.citations) {
    const resolved = await resolveRedirect(c.url, redirectCache, fetchImpl);
    const url = canonicalUrl(resolved);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const domain = domainOf(url);
    citations.push({ url, domain, source_type: sourceType(domain, { own, competitor }), rank: citations.length + 1 });
  }
  const mentions = findMentions(answer.text, project.brands, new Set(citations.map((c) => c.domain)));
  const byBrand = new Map(mentions.map((m) => [m.brandId, m]));
  return {
    run: {
      id: job.runId,
      project_id: job.projectId,
      prompt_id: job.promptId,
      provider: job.provider,
      country: job.country,
      slot: job.slot,
    },
    model: answer.model,
    answer_chars: answer.text.length,
    completed_at: new Date().toISOString(),
    mentions: project.brands.map((b) => ({
      brand_id: b.id,
      is_own: b.isOwn,
      mentioned: byBrand.has(b.id),
      position: byBrand.get(b.id)?.position ?? 0,
    })),
    citations,
  };
}

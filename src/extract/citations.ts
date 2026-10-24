// Citations: the same page arrives as many URLs (tracking parameters, www./m./amp variants,
// trailing slashes, fragments, redirect wrappers). Counting sources means first reducing each URL
// to one canonical form, then classifying its domain.
import { settings } from "../infra/config";

const UNWRAP_HOSTS = new Set(["google.com", "www.google.com"]);

export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (UNWRAP_HOSTS.has(u.hostname) && u.pathname === "/url") {
    const q = u.searchParams.get("q") ?? u.searchParams.get("url");
    return q ? canonicalUrl(q) : null;
  }
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  host = host.replace(/^(www\d?|m|mobile|amp)\./, "");
  const strip = new Set(settings().sources.strip_params);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !strip.has(k.toLowerCase()) && !k.toLowerCase().startsWith("utm_"))
    .sort(([a], [b]) => a.localeCompare(b));
  let path = u.pathname.replace(/\/{2,}/g, "/");
  path = path.replace(/\/amp\/?$/, "/").replace(/\/index\.html?$/, "/");
  path = path.replace(/\/+$/, "");
  const qs = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `https://${host}${path}${qs}`;
}

/** The registrable part of a host, good enough for the domains we classify (no public-suffix list). */
export function domainOf(canonical: string): string {
  const host = new URL(canonical).hostname;
  const parts = host.split(".");
  const twoLevel = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

export function sourceType(domain: string, brandDomains: { own: Set<string>; competitor: Set<string> }): string {
  if (brandDomains.own.has(domain)) return "own";
  if (brandDomains.competitor.has(domain)) return "competitor";
  for (const [type, domains] of Object.entries(settings().sources.types)) if (domains.includes(domain)) return type;
  return "other";
}

/** Gemini grounding links are redirects; resolve each once (and cache) to the page it points to. */
export async function resolveRedirect(url: string, cache: Map<string, string>, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!url.includes("/grounding-api-redirect/")) return url;
  const hit = cache.get(url);
  if (hit) return hit;
  try {
    const r = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(1500) });
    const loc = r.headers.get("location");
    if (loc) {
      cache.set(url, loc);
      return loc;
    }
  } catch {
    // an unresolved redirect stays as it is; it still counts as a citation of an unknown page
  }
  return url;
}

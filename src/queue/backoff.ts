/** Exponential backoff with full jitter (AWS architecture blog): uniform in [0, min(cap, base * 2^n)). */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * ceiling);
}

/** Retry-After is seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

// A run is identified by what it is: the same prompt, provider, country and schedule slot always
// give the same id, so every layer (Postgres insert, queue enqueue, ClickHouse rows, webhook event)
// can be idempotent on it.
export function runId(promptId: string, provider: string, country: string, slot: Date): string {
  return new Bun.CryptoHasher("sha256").update(`${promptId}|${provider}|${country}|${slot.toISOString()}`).digest("hex").slice(0, 24);
}

export function slotOf(now: Date, intervalMinutes: number): Date {
  const ms = intervalMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

// Typed configuration: operational settings from config/*.yaml, connection strings from the environment.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");

export type ProviderFormat = "openai" | "anthropic" | "perplexity" | "gemini" | "aio_html";

export interface ProviderConfig {
  label: string;
  format: ProviderFormat;
  path: string;
  cost_eur: number;
  bills_failed_calls?: boolean;
  rate: { per_second: number; burst: number };
  concurrency: number;
  timeout_ms: number;
  retry: { max_attempts: number; base_ms: number; cap_ms: number };
  circuit: { window_ms: number; min_calls: number; failure_rate: number; cooldown_ms: number; probes: number };
  retry_budget: { ratio: number; min_per_second: number };
}

export interface Limits {
  queue: { lease_ms: number; max_attempts: number; high_water: number; max_age_ms: number };
  worker: { concurrency: number; max_inline_wait_ms: number };
  budget: { reservation_ttl_ms: number };
  webhooks: { max_attempts: number; base_ms: number; cap_ms: number; disable_after_consecutive_failures: number; timeout_ms: number };
  analytics: { batch_rows: number; flush_ms: number };
}

export interface SourcesConfig {
  types: Record<string, string[]>;
  strip_params: string[];
}

function yaml<T>(name: string): T {
  return Bun.YAML.parse(readFileSync(join(ROOT, "config", `${name}.yaml`), "utf8")) as T;
}

let cache: { providers: Record<string, ProviderConfig>; limits: Limits; sources: SourcesConfig } | null = null;

export function settings() {
  if (!cache) {
    cache = { providers: yaml("providers"), limits: yaml("limits"), sources: yaml("sources") };
    // drills and tests start worker processes with tighter settings
    if (process.env.AVD_SETTINGS_OVERRIDE) overrideSettings(JSON.parse(process.env.AVD_SETTINGS_OVERRIDE));
  }
  return cache;
}

/** For tests and drills: override parts of the operational settings. */
export function overrideSettings(patch: {
  providers?: Record<string, Partial<ProviderConfig>>;
  limits?: Partial<{ [K in keyof Limits]: Partial<Limits[K]> }>;
}) {
  const s = settings();
  for (const [k, v] of Object.entries(patch.providers ?? {})) s.providers[k] = { ...s.providers[k]!, ...v } as ProviderConfig;
  for (const [k, v] of Object.entries(patch.limits ?? {}))
    (s.limits as unknown as Record<string, object>)[k] = { ...(s.limits as unknown as Record<string, object>)[k], ...v };
}

export function resetSettings() {
  cache = null;
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://avd:avd@127.0.0.1:5432/avd",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
  clickhouseUrl: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
  clickhouseDb: process.env.CLICKHOUSE_DB ?? "avd",
  providerBaseUrl: process.env.PROVIDER_BASE_URL ?? "http://127.0.0.1:7070",
  otlpUrl: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  apiKeys: process.env.API_KEYS ?? "",
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
};

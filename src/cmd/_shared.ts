import { clickhouse } from "../infra/clickhouse";
import { env } from "../infra/config";
import { log } from "../infra/log";
import { pg } from "../infra/pg";
import { redis } from "../infra/redis";
import { startTracing } from "../infra/tracing";

export function boot(service: string) {
  startTracing(service);
  log.info("starting", { service, pid: process.pid });
  return { sql: pg(), r: redis(), ch: clickhouse(), env };
}

/** Serve /metrics and /healthz for processes that are not the API. */
export function sidecar(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const { registry } = await import("../infra/metrics");
      const p = new URL(req.url).pathname;
      if (p === "/metrics") return new Response(await registry.metrics(), { headers: { "content-type": registry.contentType } });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  });
}

export function onShutdown(fn: () => Promise<void> | void) {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      log.info("shutting down", { signal: sig });
      await fn();
      process.exit(0);
    });
  }
}

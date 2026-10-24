import { settings } from "../infra/config";
import { Worker } from "../runs/worker";
import { boot, onShutdown, sidecar } from "./_shared";

const { sql, r, env } = boot("worker");
sidecar(Number(process.env.METRICS_PORT ?? 9101));
const crash = Number(process.env.DRILL_CRASH_AFTER_CALL_RATE ?? 0);
const w = new Worker(r, sql, {
  providerBaseUrl: env.providerBaseUrl,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? settings().limits.worker.concurrency),
  crashAfterCallRate: crash,
});
onShutdown(() => w.stop());
await w.start();

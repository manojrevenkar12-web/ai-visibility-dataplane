import { Scheduler } from "../runs/scheduler";
import { boot, onShutdown, sidecar } from "./_shared";

const { sql, r } = boot("scheduler");
sidecar(Number(process.env.METRICS_PORT ?? 9102));
const s = new Scheduler(r, sql);
onShutdown(() => s.stop());
await s.start(Number(process.env.TICK_MS ?? 1000));

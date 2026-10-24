import { AnalyticsShipper } from "../runs/shipper";
import { WebhookDeliverer } from "../webhooks/webhooks";
import { boot, onShutdown, sidecar } from "./_shared";

// Ships analytics to ClickHouse and delivers webhooks: both drain Postgres outboxes.
const { sql, ch } = boot("shipper");
sidecar(Number(process.env.METRICS_PORT ?? 9103));
const shipper = new AnalyticsShipper(sql, ch);
const hooks = new WebhookDeliverer(sql);
onShutdown(() => {
  shipper.stop();
  hooks.stop();
});
await Promise.all([shipper.start(), hooks.start()]);

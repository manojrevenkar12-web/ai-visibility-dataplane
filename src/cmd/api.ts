import { buildApi } from "../api/app";
import { boot, onShutdown } from "./_shared";

const { sql, r, ch, env } = boot("api");
const app = buildApi({ sql, redis: r, ch, apiKeys: env.apiKeys }).listen(Number(process.env.PORT ?? 3000));
onShutdown(async () => {
  await app.stop();
});

import { closePg } from "../infra/pg";
import { closeRedis } from "../infra/redis";
import { reparseQuarantine } from "../runs/reparse";
import { boot } from "./_shared";

const { sql, r } = boot("reparse");
console.log(JSON.stringify(await reparseQuarantine(sql, r)));
await closePg();
await closeRedis();

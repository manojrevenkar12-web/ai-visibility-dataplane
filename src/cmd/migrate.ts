import { clickhouse } from "../infra/clickhouse";
import { closePg, migratePg } from "../infra/pg";

const applied = await migratePg();
console.log(applied.length ? `postgres: applied ${applied.join(", ")}` : "postgres: up to date");
await clickhouse().migrate();
console.log("clickhouse: up to date");
await closePg();

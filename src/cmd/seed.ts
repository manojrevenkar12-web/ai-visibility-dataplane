// Load the simulator's world into the local stack (projects, brands, prompts).
import { seedWorld } from "../drills/seed";
import { closePg, migratePg, pg } from "../infra/pg";
import { makeWorld } from "../sim/world";

const sql = pg();
await migratePg(sql);
const world = makeWorld(Number(process.env.SIM_PROJECTS ?? 12), Number(process.env.SIM_PROMPTS ?? 25), process.env.SIM_SEED ?? "local");
await sql`TRUNCATE project CASCADE`;
await seedWorld(sql, world, {});
console.log(`seeded ${world.length} projects, ${world.reduce((a, p) => a + p.prompts.length, 0)} prompts`);
await closePg();

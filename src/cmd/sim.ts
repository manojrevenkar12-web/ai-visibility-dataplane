// The provider simulator as a standalone service (for docker compose and local runs).
import { ProviderSim } from "../sim/provider-sim";
import { makeWorld } from "../sim/world";

const world = makeWorld(Number(process.env.SIM_PROJECTS ?? 12), Number(process.env.SIM_PROMPTS ?? 25), process.env.SIM_SEED ?? "local");
const limit = Number(process.env.SIM_LIMIT ?? 40);
const providers = Object.fromEntries(
  ["openai", "anthropic", "perplexity", "gemini", "ai_overview"].map((p) => [
    p,
    { limitPerSecond: limit, latencyMs: [40, 400] as [number, number], errorRate: 0.01, truncatedRate: 0.005, slowRate: 0.002 },
  ]),
);
const sim = new ProviderSim({ seed: "local", providers, costs: {} }, world).listen(Number(process.env.PORT ?? 7070));
console.log(`provider simulator on ${sim.url}`);

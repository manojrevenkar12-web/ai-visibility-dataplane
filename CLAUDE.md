# Working on this repository

Fast feedback: `bun test --timeout 60000` (needs Postgres, Redis and ClickHouse; see README),
`bunx tsc --noEmit -p .`, `bunx biome check src test`. The drills (`bun run src/cmd/drill.ts`,
then `bun run src/cmd/gate.ts`) take about five minutes and are the release gate.

Invariants (each has a test or a drill check; keep it that way):
- Postgres is the record of every run. Redis may lose the queue and the system must recover from Postgres.
- Any write that completes or fails a run goes through the run's lease fence (`RunStore.complete/fail`).
- Anything that costs money (a provider call) happens only while the lease is known to be held,
  and is written to the ledger *before* it is made.
- ClickHouse is written only by the outbox shipper. Customer queries read FINAL.
- Limits live in Redis and are shared by all workers. Never add a per-process limiter.
- Lua scripts return integers. Round explicitly: Redis truncates numbers.
- A provider response nobody can parse is quarantined, not retried.
- Settings live in `config/*.yaml`, not in code. Drills override them via `AVD_SETTINGS_OVERRIDE`.
- Held-out answers (`heldout/<set>/answers.yaml`): never change extraction to pass a set before
  its first run is recorded. `reports/heldout/<set>/first_run.json` is not rewritten. If you study
  a set's failures, mark it a regression set and have someone who has not seen the code write a new
  one from `heldout/WRITING_ANSWERS.md` only.

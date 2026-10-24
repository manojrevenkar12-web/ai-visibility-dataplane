# Postmortem: runs paid for twice when a lease expired during rate-limit waits

Found by: drill `steady`, first run. Severity, had it shipped: cost (about 17% extra spend on the
slowest provider) and wasted provider quota; no customer-visible data error.

## What happened

In the first `steady` drill, the AI Overview provider answered **701 successful calls for 600
runs**: 101 runs were paid for twice. Every other provider had exactly 600. ClickHouse still had
exactly one row per run, so customers would not have seen it; the bill would have.

Source: [`data/steady-before-lease-fix.json`](data/steady-before-lease-fix.json) and the
`provider_call` table of that run (`ai_overview | ok | 200 | 701`).

## Why

The worker renewed its queue lease only *during* the provider call. Before the call it may wait
for a rate-limit token, and it waited in a loop of short sleeps (each under
`max_inline_wait_ms`) with no bound on the total. AI Overview has the lowest limit (18/s) and
96 runs in flight competed for it, so some runs waited longer than the 2 s lease. The lease
expired, the reaper handed the run to a second worker, and both called the provider.

The fencing did its job for the data: the first worker's result was refused (its fence was older)
and only one result was written. Fencing protects correctness, not cost: by the time a stale
holder writes, it has already paid.

## Fix

1. The lease is renewed for the whole time a worker holds a run, from lease to ack, not only
   during the call (`Worker.keepLease`).
2. A worker that notices its lease was lost **does not call the provider**; it releases its cost
   reservation and drops the run (another worker owns it).
3. Inline rate-limit waiting is bounded in total (two `max_inline_wait_ms`); a longer wait gives
   the run back to the queue with the exact delay instead.

After the fix the same drill made exactly 600 successful calls per provider, and the run took
34 s instead of 65 s, because workers stopped holding slots while sleeping.

## The second finding in the same run

The ledger was €0.083 below what the provider billed. The difference was exactly the 9 calls the
worker abandoned at its timeout (slow-tail responses the provider completed and billed). Those
calls are now recorded at full cost (`ProviderError.timedOut`), so the ledger and the budget can
over-count a call that was never processed but never under-count one that was. In the drill
after the fix, ledger and provider bill match to the cent.

## What we keep

- A drill invariant: successful provider calls per run ≤ 1 (`providers.*.ok` vs runs).
- A test: a stale lease holder does not call the provider (`test/integration/pipeline.test.ts`).
- The rule: fencing makes writes safe; it does not make side effects free. Anything that costs
  money happens only while the lease is known to be held.

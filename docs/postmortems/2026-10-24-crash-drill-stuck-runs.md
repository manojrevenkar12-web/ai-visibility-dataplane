# Postmortem: under crashes and a queue loss, 41 runs never finished and the ledger under-counted

Found by: drill `crash`, first and second runs. Severity, had it shipped: page. Runs silently
never collected, and spend not recorded.

## What happened

The drill kills a worker process right after 3% of provider calls (before anything is recorded),
crashes the analytics shipper after 20% of ClickHouse inserts (before marking them shipped), and
drops the queue's contents from Redis 3 s in. The first run timed out after 240 s with
**41 runs that never reached a terminal state**. The cost ledger showed **€28.81 against
€33.91** billed by the provider.

Source: [`data/crash-before-orphan-fix.json`](data/crash-before-orphan-fix.json).

## Why: three separate faults

1. **Orphaned queue ids.** The queue loss removed job hashes but some ids stayed in the leased
   set. When those leases expired, the lease script wrote a fence into the missing hash, which
   *re-created it without a payload*. The worker could not run it. The reconciler, which re-queues
   runs Postgres has but Redis lacks, saw that the hash existed and left the run alone. The run
   was stuck for good.
2. **The retry budget was spent on crash recovery.** A run re-leased after its worker died counted
   as a retry, and retries are limited to 20% of first attempts. Once all first attempts were done,
   crash recovery was throttled to the budget's floor of 2 a second per provider. Even after
   fault 1 was fixed, the second run left 79 runs unfinished at the timeout.
3. **The ledger was written after the call.** A worker killed between the provider's answer and
   the ledger insert left no trace of a call the provider billed. The same applied to the budget:
   an expired reservation was simply released.

## Fixes

1. The lease script skips an id whose job has no payload instead of re-creating it. The
   reconciler checks for the payload, not just the key. (test: "ids whose job was lost are skipped")
2. The queue counts provider failures separately from attempts. Only a retry caused by the
   provider (throttled, unavailable, truncated) spends the retry budget; a re-run after a crash or
   an expired lease does not.
3. Write-ahead ledger: the call is inserted at its expected cost before it is made and updated
   with the outcome afterwards. Budget reservations that expire unsettled are counted as spent.

| | First run | After the fixes |
|---|---|---|
| Finished | no, timed out at 240 s | yes, 62 s (88 worker restarts) |
| Runs not finished | 41 | 0 (2,999 collected, 1 reported as `exhausted`) |
| Duplicates visible to customers | 0 | 0 |
| Ledger vs provider bill | €28.81 vs €33.91 (under) | €34.10 vs €33.94 (over by calls that died before reaching the provider) |

## What we keep

- Gate checks on every drill: every run finishes, and the ledger is never below the provider's bill.
- The principle: anything Redis holds can be lost, so every Redis structure needs a path back
  from Postgres, and each one is tested by dropping it.

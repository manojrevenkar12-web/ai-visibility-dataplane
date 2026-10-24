# ADR 0004: A response no parser understands is kept, not retried

Status: accepted

## Context
Providers change response formats without notice. A worker that treats an unknown shape like a
transient error retries it, pays again each time, and fails anyway. A worker that drops it loses
the answer, which was paid for and cannot be fetched again for that time slot.

## Decision
Parsing distinguishes a body that is not valid JSON (truncated: retry) from valid JSON in an
unknown shape (drift: do not retry). On drift the raw body is stored in `quarantine`, the run fails
with `schema_drift`, an alert fires, and the customer sees "delayed, no action needed". After a
parser for the new shape ships, `bun run src/cmd/reparse.ts` completes those runs from the stored
bodies, with a fresh fence and no provider call.

## Consequences
+ Drill `drift`: every affected run recovered after the fix, with no extra provider spend.
− Quarantine stores full bodies (up to 200 KB each); retention is a policy decision (30 days here).

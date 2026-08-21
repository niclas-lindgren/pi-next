# Plan: Issue #72

## Authority snapshot

- Issue #72 is open and currently owned by this run (`issue-72-followup-1787345837`).
- Follow-up scope: bounded, observable candidate discovery after stable-host issue yields.
- Required invariants: final lease CAS remains authoritative; foreign leases are skipped; no queue-sized fan-out; no routine host-session replacement.

## Implementation slices

- Add bounded authority subprocess and scheduler-operation deadlines, including GitHub lease/discovery and main refresh operations.
- Replace queue-wide lease fan-out with progressive, bounded-concurrency candidate inspection and bounded payload retention.
- Thread scheduler status through the foreground display and expose explicit unavailable/watchdog diagnostics.
- Add outer-path regressions for progressive lease reads, timeout containment, status phases, and stable-host `newSession` invariants.

## Verification

- `npm run typecheck`
- `npm test`
- Focused candidate/scheduler/supervisor tests.

## Completion evidence

- Re-query issue authority immediately before candidate commit/finalization and again after push before closure.

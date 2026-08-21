# Plan: Issue #68

## Authority snapshot

- Issue: #68, `fix(scheduler): treat fresh-owner claim races as candidate-local skips instead of aborting the whole auto run`
- Snapshot: 2026-08-21, open and unassigned; requires fresh-owner races to remain fail-closed for persisted resume while normal candidate selection continues.
- Scope: add durable scheduler-local lease-conflict skips, retry selection without consuming requested capacity or worker steps, preserve idle semantics, and expose telemetry/status distinctions.

## Implementation slices

- Pass injected authority through candidate discovery and add bounded current-run scheduler skip records separate from blocked/deferred issue outcomes.
- Catch only fresh-owner conflicts after a newly selected candidate's CAS, record `fresh_owner` scheduler telemetry, and reselect; leave persisted-owner resume uncaught/fail-closed.
- Add scheduler status/progress rendering and actual claim-boundary regression coverage for race, pre-filter, all-leased idle, and no-worker behavior.

## Verification

- `npm run typecheck`
- `npm test`
- Focused scheduler/coordination tests.

## Completion evidence

- Re-query issue authority immediately before candidate commit/finalization and again after push before closure.

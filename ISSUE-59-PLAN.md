# Issue #59 plan

## Goal
Bound isolated worker liveness while distinguishing process liveness, progress activity, watchdog timeout, and explicit controller abort.

## Implementation
- Add validated global/role watchdog policies with conservative defaults and per-worker overrides.
- Track last structured activity kind, idle age, wall-clock age, and process state.
- Persist bounded watchdog diagnostics, surface suspected stalls/timeouts, terminate process groups with SIGTERM/grace/SIGKILL, and preserve worker state.
- Let watchdog exits use existing bounded missing-result same-issue recovery while keeping explicit abort distinct.
- Add watchdog regression coverage and distinct display states.

## Verification
- `npm run typecheck`
- `npm test`
- Re-query issue authority before guarded finalization.

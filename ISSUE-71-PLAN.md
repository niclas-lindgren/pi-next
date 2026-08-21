# Plan: Issue #71

## Authority snapshot

- Issue: #71, `fix(recovery): make clean restart_required runs runnable before recovered supervisor launch`
- Snapshot: 2026-08-21, open; focused P0/P1 recovery defect related to #69.
- Scope: reactivate only authority-validated recoverable abandoned states, re-baseline host memory before launch, preserve the canonical issue lease/worktree, and report whether recovery actually resumed.

## Implementation slices

- Separate abandoned-transition inspection from explicit terminal-state reactivation in `prepareAbandonedAutoResume()`.
- Recognize interrupted states and the exact memory-pressure `restart_required` stop, while rejecting generic operator stops and invalid workspaces.
- Preserve bounded memory diagnostics but reset the new process baseline; immediately re-stop on current critical pressure.
- Add outer recovery/supervisor regressions for settled-boundary resume, same-issue ordering, generic stop rejection, and current-process pressure.

## Verification

- `npm run typecheck`
- `npm test`
- Focused abandoned-recovery and host-memory tests.

## Completion evidence

- Re-query issue authority before candidate commit/finalization and after push before closure.
- Prove the candidate is reachable from `origin/main`; remove only the clean integrated canonical worktree.

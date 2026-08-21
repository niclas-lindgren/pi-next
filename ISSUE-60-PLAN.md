# Issue #60 plan

## Goal
Add durable per-issue convergence/fairness budgets without confusing scheduler yield with product failure or authority defer.

## Implementation
- Add validated soft/hard transition, wall-time, token, and PLAN fragmentation policy.
- Persist issue transition, worker, commit, verification, task, fingerprint, wall-time, and token metrics across sessions.
- Check hard budgets before each active PLAN worker and use the existing non-destructive `yield_issue` boundary.
- Surface soft checkpoints and budget/task metrics in loop and issue status; guide cohesive PLAN slices.
- Add regression coverage for configurable budgets and micro-progress accounting.

## Verification
- `npm run typecheck`
- `npm test`
- Re-query issue authority before guarded finalization.

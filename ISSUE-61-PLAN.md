# Issue #61 plan

## Goal
Continuously apply the configured authority eligibility policy to active PLAN execution, preserving work and yielding safely when authority blocks, closes, defers, or cannot be verified.

## Implementation
- Centralize authoritative eligibility classification and use it for candidate selection, freshness, active execution, and issue status.
- Carry eligibility disposition through live freshness results.
- Add a non-destructive `yield_issue` boundary that preserves PLAN/worktree state and excludes the issue for the current run.
- Re-check authority before worker launch and before workspace handoff when an authority adapter is injected.
- Add regression coverage for shared readiness/blocker classification.

## Verification
- `npm run typecheck`
- `npm test`
- Inspect diff and run live authority re-query before finalization.

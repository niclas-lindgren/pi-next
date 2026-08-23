# Issue #53 plan

## Authority
- GitHub issue: #53
- Scope: keep non-terminal worker tool errors visible without changing lifecycle status.

## Plan
1. Separate activity error presentation from terminal worker lifecycle in `WorkerDisplayController`.
2. Add regression coverage for active error, later activity, and explicit terminal finish states.
3. Run `npm run typecheck` and `npm test`, inspect the diff, then commit.

## Verification evidence
- `npm run typecheck` passes.
- `npm test` passes: 136 tests.
- Non-terminal error events remain visible while lifecycle status stays active.
- Explicit `finish(..., "failed")` still renders terminal failure.

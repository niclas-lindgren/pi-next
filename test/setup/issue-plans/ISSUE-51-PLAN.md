# Issue #51 plan

## Authority
- GitHub issue: #51
- Scope: rebind the live host context at the missing-loop-result replacement-worker boundary and preserve truthful startup failures.

## Plan
1. Trace the recovery loop and shared live-context registry.
2. Require a current registry context before replacement launch; never reuse the captured worker/session context.
3. Make replacement attachment/start activity explicit and preserve exact bounded startup failures.
4. Add regression coverage for stale-context rebinding and missing-context failure.
5. Run `npm run typecheck` and `npm test`, inspect the diff, then commit.

## Verification evidence
- `npm run typecheck` passes.
- `npm test` passes: 135 tests.
- Replacement cycles use the shared live-context registry and fail explicitly when no live context exists.
- Activity now distinguishes live-session attachment and replacement-worker startup.
- Regression tests cover stale-context rebinding and bounded no-live-context failure.

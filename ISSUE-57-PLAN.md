# Issue #57 plan

## Authority
- GitHub issue: #57
- Scope: bind worker dispatch/prompt guidance to configured Pi-next workflow artifact paths and forbid fallback probing.

## Plan
1. Expose configured PLAN/VERIFY/state/diagnostics paths in worker dispatch envelopes.
2. Bind normal, loop, and maintenance prompts to those paths and remove misleading hard-coded VERIFY error text.
3. Add custom-path regression coverage.
4. Run `npm run typecheck` and `npm test`, inspect the diff, then commit.

## Verification evidence
- `npm run typecheck` passes.
- `npm test` passes: 137 tests.
- Worker dispatch envelopes now carry configured PLAN/VERIFY/state/diagnostics paths and explicitly forbid fallback probing.
- Custom workflow-path prompt coverage passes; archive errors identify the configured VERIFY path.

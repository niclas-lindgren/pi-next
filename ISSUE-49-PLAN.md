# Issue #49 plan

## Authority
- GitHub issue: #49
- Scope: add autonomous-entry workflow state-provider preflight required by the latest authoritative comment.

## Plan
1. Trace the `/pi-next auto`/fresh entry and the earliest common supervisor boundary before issue claim, mutation, or worker launch.
2. Add a package-owned preflight that resolves and validates the configured workflow state provider, including helper contract output, without changing ownership semantics.
3. Wire the preflight into autonomous entry and preserve explicit override fail-closed behavior.
4. Add regression coverage proving invalid explicit providers launch no worker and valid builtin/helper providers proceed.
5. Run `npm run typecheck` and `npm test`, inspect the diff, then commit.

## Verification evidence
- `npm run typecheck` passes.
- `npm test` passes: 133 tests.
- Invalid explicit helpers are rejected before run-state creation, authority lease calls, abandoned-run recovery, or worker launch.
- Built-in and valid helper providers are exercised through the same preflight contract.

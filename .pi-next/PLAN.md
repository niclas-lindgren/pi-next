# Plan: Issue #49

**Goal:** Make workflow state inspection portable by default with a package-owned provider and explicit authoritative consumer overrides.

**GitHub-Issue:** #49

## Tasks
- [x] Add package-owned built-in state provider and explicit validated helper override configuration.
  - Files: src/coordination/config.ts, extensions/pi-next/workflow-state-provider.ts
  - Approach: default to configured-path PLAN parsing; validate explicit helper path, bounded output, timeout, and schema without fallback.
- [x] Route state inspection/status/doctor through the provider resolver and preserve bounded output/typed failures.
  - Files: extensions/pi-next/tools-inspect.ts, extensions/pi-next/commands.ts
  - Approach: use the selected provider for all generic state surfaces and classify provider failures as repository/configuration integration errors.
- [x] Add fresh-consumer and provider regression coverage for defaults, custom paths, overrides, malformed/missing helpers, and precedence.
  - Files: examples/consumer-fixture/.pi-next/scripts/pi-next-state.sh, test/workflow-state-provider.test.ts, test/consumer-smoke.test.ts
  - Approach: remove the implicit legacy helper from the fixture and exercise explicit overrides only in isolated fixtures.

## Acceptance Criteria
- [x] Generic state inspection works without `pi-next-state.sh`.
- [x] Built-in is the default and respects configured workflow paths.
- [x] Explicit valid helpers are authoritative; broken explicit helpers fail without fallback.
- [x] Legacy helper presence alone does not override built-in behavior.
- [x] Provider output is bounded and schema-validated without raw secrets/environment data.
- [x] Doctor/status/inspect identify/use the selected provider.
- [x] Fresh-consumer and provider regression coverage passes.

## Log
- 2026-08-21: Selected live open issue #49 after completing #48; claimed lease and prepared `.worktrees/issue-49`.
- 2026-08-21: Implemented built-in/override provider routing and passed full typecheck/test suite.

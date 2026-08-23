# Issue #54 plan

## Authority
- GitHub issue: #54
- Scope: expose bounded, read-only self-assessment health, findings, configuration, and publication diagnostics without affecting issue ownership or completion.

## Plan
1. Trace self-assessment persistence/publication and command registration.
2. Persist bounded publication/approval outcomes while retaining best-effort lifecycle behavior.
3. Add `/pi-next-assessment` status output for config, deterministic health, findings, eligibility, and publication state.
4. Add regression coverage for disabled/healthy states, findings, publication failures, sanitization, and bounded output.
5. Run `npm run typecheck` and `npm test`, inspect the diff, then commit and finalize through guarded coordination.

## Verification evidence
- `npm run typecheck` passes in `.worktrees/issue-54`.
- `npm test` passes: 141 tests.
- `/pi-next-assessment` reports configuration, deterministic health, bounded findings, eligibility, authority identity, and publication diagnostics without invoking a model or mutating work authority.
- Publication and approval-refresh failures are sanitized, persisted locally, and retryable; successful publication records published/updated state.
- `test/self-assessment.test.ts` covers bounded publication/approval failure diagnostics and secret sanitization.

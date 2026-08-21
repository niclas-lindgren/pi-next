# Issue #55 plan

## Authority
- GitHub issue: #55
- Scope: expose a read-only bounded issue queue using the configured authority, candidate policy, and lease state.

## Plan
1. Reuse live authority discovery, configured priority/readiness/blocked policy, and lease CAS reads.
2. Add `/pi-next-issues` filters and bounded classifications for current, eligible, leased, deferred, blocked, and unknown ownership.
3. Add regression coverage for command registration/output and ensure the command is read-only.
4. Run `npm run typecheck` and `npm test`, inspect the diff, then commit and finalize through guarded coordination.

## Verification evidence
- `npm run typecheck` passes in `.worktrees/issue-55`.
- `npm test` passes: 141 tests.
- `/pi-next-issues` uses the configured authority and existing candidate shortlist policy, reads leases without mutation, reports current/eligible/leased/deferred/blocked/unknown classifications, and bounds default output with an `all` mode.

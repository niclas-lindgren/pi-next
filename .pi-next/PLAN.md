# Plan: Issue #45

**Goal:** Recover safely attributable abandoned auto runs before normal candidate selection, including matching stale leases reclaimed through the existing CAS resume path.

**GitHub-Issue:** #45

## Tasks
- [x] Broaden abandoned-run discovery to accept only mechanically matching stale leases in addition to matching fresh leases, while keeping missing and foreign ownership fail-closed.
  - Files: extensions/pi-next/commands-recovery.ts, extensions/pi-next/foreground-supervisor.ts
  - Approach: preserve authority-first owner matching and let the normal `claimLoopIssue()`/`reconcileIssueLeaseForResume()` path perform stale CAS takeover before launching the recovered worker.
- [x] Add regression coverage for stale lease restart, foreign ownership, and recovery-before-candidate-selection behavior.
  - Files: test/commands-recovery.test.ts (or focused existing recovery test)
  - Approach: use isolated temporary repositories and in-memory authorities; assert dirty work survives and candidate discovery is not reached when recovery is attributable.

## Acceptance Criteria
- [ ] `/pi-next auto` recovery preflight runs before normal candidate selection.
- [ ] A stale lease matching the persisted abandoned run is eligible for the existing CAS resume reconciliation.
- [ ] Fresh foreign ownership, missing authority, malformed state, and non-canonical workspaces remain fail-closed.
- [ ] Dirty and committed issue-worktree work is preserved.
- [ ] `/pi-next-loop resume` continues sharing the same lease reconciliation semantics.
- [ ] Required typecheck and tests pass.

## Log
- 2026-08-21: Selected P1 issue from live GitHub queue; claimed lease #45 and prepared `.worktrees/issue-45`.
- 2026-08-21: Recovery discovery now admits only matching stale owners; normal resume performs CAS takeover and emits recovered claim telemetry. Added isolated stale/foreign/dirty/order regression coverage.

# Plan: Issue #69

**Goal:** prove stable-host parent memory is bounded and release superseded host references before pressure fencing.

**GitHub-Issue:** #69

## Tasks

- [x] Release superseded host/session contexts from live-context and heartbeat bridges without weakening genuine lifecycle rebinding.
  - Files: extensions/pi-next/live-ctx.ts, extensions/pi-next/commands-recovery.ts, test/host-retention.test.ts
  - Approach: weak-reference non-current context registries and avoid strong heartbeat fallbacks; preserve current live context and run-scoped rebinding.
- [x] Add opt-in retained-heap diagnostics and bounded-envelope analysis.
  - Files: extensions/pi-next/host-memory.ts, test/host-memory.test.ts
  - Approach: sample after optional forced GC only when explicitly enabled, retain payload-free bounded evidence, and expose trend analysis for long-run diagnostics.
- [x] Exercise the outer stable-host controller through 50+ worker transitions and document the evidence.
  - Files: test/plan-recovery-controller.test.ts, docs/HOST_SESSION_LIFECYCLE.md, CHANGELOG.md
  - Approach: extend the production-path regression, assert zero host replacements and bounded diagnostic state, and record the identified Pi-next retention source.

## Acceptance Criteria

- [x] Superseded contexts are not strongly retained by Pi-next lifecycle bridges.
- [x] Retained-heap diagnostics are opt-in, payload-free, bounded, and distinguish transient from settled growth.
- [x] The outer stable-host path covers 50+ isolated transitions with zero Pi-next host-session replacements.
- [x] `npm run typecheck` and `npm test` pass.

## Log

- 2026-08-22: Claimed issue #69 and refreshed canonical worktree from current main, preserving the prior integrated issue branch history. Authority snapshot: title unchanged, open, latest requirement is stable-host 50+ transition evidence after #72.
- 2026-08-22: Implemented weak historical context bridges, weak heartbeat fallback, opt-in retained-heap envelope diagnostics, and 51-transition stable-host outer-path evidence. `npm run typecheck` and `npm test` pass (207 tests).

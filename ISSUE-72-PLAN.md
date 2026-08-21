# Plan: Issue #72

**Goal:** Keep `/pi-next auto` on one stable parent Pi host session while preserving isolated child-worker freshness and truthful telemetry.

## Tasks

- [x] Replace routine `ctx.newSession()` rotation in the production auto loop with controller-local worker batches and preserve maintenance/worker execution semantics.
  - Files: extensions/pi-next/loop-controller.ts, extensions/pi-next/loop-state.ts, extensions/pi-next/host-memory.ts
  - Approach: run bounded child-worker batches directly on the live context, rename batch state/diagnostics, keep legacy persisted fields readable, and retain host-memory fencing.
- [x] Separate worker/controller/host-session telemetry and remove misleading session-batch footer output.
  - Files: extensions/pi-next/loop-state.ts, extensions/pi-next/auto-progress.ts, extensions/pi-next/loop-maintenance.ts, extensions/pi-next/loop-status.ts, extensions/pi-next/performance-publication.ts
  - Approach: add additive counters with compatibility defaults, keep historical fields interpretable, and render worker/controller terminology.
- [x] Audit stable live-context ownership and update architecture documentation for genuine external replacement only.
  - Files: extensions/pi-next/live-ctx.ts, extensions/pi-next/foreground-supervisor.ts, extensions/pi-next/loop.ts, extensions/pi-next/util-core.ts, extensions/pi-next/README.md
  - Approach: remove routine-rotation assumptions, bound same-host context bookkeeping, and document child-process freshness.
- [x] Add outer-path regression coverage for stable parent context, maintenance/scheduler paths, telemetry, footer, and child-worker isolation.
  - Files: test/plan-recovery-controller.test.ts, test/auto-progress.test.ts, test/loop-state.test.ts
  - Approach: exercise `runLoopSteps` with mocked workers and assert no `newSession()` call across repeated transitions; update compatibility expectations.

## Acceptance Criteria

- Normal auto execution makes zero Pi-next-initiated `ctx.newSession()` calls.
- Fresh planning/implementation/recovery work remains in isolated child workers.
- Telemetry distinguishes worker turns, controller transitions, and actual host replacements; footer no longer says `session x/3`.
- Host-memory pressure safety remains enabled.
- Genuine host lifecycle replacement continues to use live-context rebinding and durable recovery.

## Log

- 2026-08-21: Claimed issue #72 and created canonical `agent/issue-72` worktree.
- 2026-08-21: Implemented stable-host worker batches, additive telemetry migration, live-context run binding, and outer-path regressions. Typecheck and full test suite pass.
- 2026-08-21: Re-queried authority after implementation; reconciled the new policy comment and refreshed `origin/main` so the lifecycle decision record and child-worker freshness policy are included in the candidate.

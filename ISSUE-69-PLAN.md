# Plan: Issue #69

## Authority snapshot

- Issue: #69, `perf(runtime): bound parent Pi heap growth across long auto runs and recover before host OOM`
- Snapshot: 2026-08-21, open; unassigned; P0/P1 reliability issue covering parent memory telemetry, lifecycle retention, pressure safety, and abrupt-restart recovery.
- Scope: measure payload-free parent memory at lifecycle boundaries, provide bounded retained-growth diagnostics and pressure fencing, and prove the outer supervisor/recovery path preserves the active issue.

## Implementation slices

- Audit existing supervisor/session, live-context, generation, heartbeat, parser, and display teardown ownership; add compact bounded memory-health telemetry at start, transitions, worker/issue boundaries, and settle/abort.
- Add configurable/conservative pressure classification and a durable `restart_required` boundary that prevents another worker launch while preserving ownership/worktree recovery state.
- Add outer supervisor/restart regressions plus focused retention/telemetry tests; avoid retaining prompts, transcripts, or tool payloads.

## Verification

- `npm run typecheck`
- `npm test`
- Focused memory/lifecycle/supervisor/recovery tests and diff checks.

## Completion evidence

- Re-query issue authority immediately before candidate commit/finalization and again after push before closure.
- Prove candidate reachability from `origin/main`; release lease and remove only the clean integrated canonical worktree.

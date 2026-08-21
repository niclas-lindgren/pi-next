# Plan: Issue #70

## Authority snapshot

- Issue: #70, `fix(footer): preserve bound auto status continuously across ctx.newSession without heartbeat flicker`
- Snapshot: 2026-08-21, open; follow-up specifically covers final repaint after early recovered-run supervisor termination.
- Scope: preserve exact bound footer identity through normal session replacement and command finalization without retaining stale host contexts or weakening conservative unbound selection.

## Implementation slices

- Allow the heartbeat's final synchronous repaint to use the still-valid command context when the supervisor has already cleared the live-context bridge.
- Keep normal heartbeat writes live-context-only and preserve exact-run binding/isolation.
- Add an outer-style regression for neutral initial paint -> recovered binding -> cleared live bridge -> final terminal repaint.

## Verification

- `npm run typecheck`
- `npm test`
- Focused auto-status lifecycle tests and diff checks.

## Completion evidence

- Re-query issue authority before candidate finalization and after push before closure.
- Prove candidate reachability from `origin/main`; release lease and remove only the clean integrated canonical worktree.

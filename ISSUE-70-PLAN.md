# Plan: Issue #70

## Authority snapshot

- Issue: #70, `fix(footer): preserve bound auto status continuously across ctx.newSession without heartbeat flicker`
- Snapshot: 2026-08-21, open; P1 UX/reliability regression covering bound footer repaint, conservative unbound selection, and session isolation.
- Scope: preserve the exact already-bound run identity across host session replacement without weakening `selectCurrentLoop()`.

## Implementation slices

- Record the foreground controller's presentation-only run binding before session transitions and carry it through shutdown/start handoff, including durable replacement-session metadata.
- Repaint the exact bound run synchronously in the replacement context; retain conservative session-scoped discovery when no binding exists and preserve independent-session isolation.
- Add repeated outer lifecycle regression coverage with ambiguous historical records and prove no blank status gap before the heartbeat.

## Verification

- `npm run typecheck`
- `npm test`
- Focused auto-status lifecycle tests and diff checks.

## Completion evidence

- Re-query issue authority immediately before candidate commit/finalization and again after push before closure.
- Prove candidate reachability from `origin/main`; release lease and remove only the clean integrated canonical worktree.

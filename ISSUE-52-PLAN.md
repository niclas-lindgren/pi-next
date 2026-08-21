# Issue #52 plan

## Authority
- GitHub issue: #52
- Scope: make loop status run-scoped, distinguish durable running records from proven controller liveness, reconcile/present stale history safely, and bound default history output.

## Plan
1. Trace durable loop state, controller-lock evidence, footer selection, and `/pi-next-loop status`.
2. Add pure bounded status classification/summary helpers using lock/PID evidence without mutating ownership.
3. Update footer/status to resolve the session-owned run explicitly and expose actionable current/live/recoverable/history sections, with verbose history support.
4. Add regression coverage for live/dead/missing controller evidence, run identity, bounded history, and no-session behavior.
5. Run `npm run typecheck` and `npm test`, inspect the diff, then commit and finalize through guarded coordination.

## Verification evidence
- `npm run typecheck` passes in `.worktrees/issue-52`.
- `npm test` passes: 140 tests.
- `/pi-next-loop status` now identifies a session-bound run, classifies persisted running records from controller-lock/PID evidence, performs bounded authoritative lease checks, and supports summary/history output.
- Footer and supervisor status use the same session-aware, liveness-aware run resolver; missing/dead controller evidence never renders as live running.
- `test/loop-status.test.ts` covers live/dead/missing locks, session identity/ambiguity, and bounded versus verbose history.

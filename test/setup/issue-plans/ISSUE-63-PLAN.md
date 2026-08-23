# Issue #63 plan

## Authority snapshot

- Issue: #63, `fix(display): keep scheduler-only cycles stable and do not render worker alive when no worker exists`
- Snapshot: 2026-08-21, open; assignee `niclas-lindgren`; no comments.
- Scope: worker display lifecycle and auto-progress reason classification only.

## Implementation slices

- Keep the supervisor-owned worker display attached across bounded issue-cycle transitions; do not clear it for scheduler-only empty states.
- Remove the false empty-worker `worker alive` placeholder and provide bounded truthful controller/settled status where appropriate.
- Distinguish convergence budget yields from recovery retry exhaustion in footer classification.
- Add focused regression tests for empty/scheduler-only display, lifecycle handoff, and reason classification; preserve session replacement safety.

## Verification

- `npm run typecheck`
- `npm test`
- Focused worker display and auto-progress tests.

## Completion evidence

- Re-query issue authority immediately before commit/finalization and again after push before closure.

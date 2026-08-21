# Issue #65 plan

## Authority snapshot

- Issue: #65, `fix(checkpoint): use the canonical agent/issue worktree branch instead of a second per-run branch identity`
- Snapshot: 2026-08-21, open; assigned to `niclas-lindgren`; no comments.
- Scope: Pi-next checkpoint branch selection and canonical issue-worktree safety.

## Implementation slices

- Derive checkpoint branches from the shared canonical issue workspace identity and retain run IDs only as validation/telemetry input.
- Keep checkpoint and resume operations on `agent/issue-N`, with explicit-path staging and existing main/foreign-branch guards intact.
- Add temporary-repository regression coverage for canonical checkpointing, restart/resume, dirty explicit paths, production-main protection, and foreign branches.

## Verification

- `npm run typecheck`
- `npm test`
- Focused checkpoint tests.

## Completion evidence

- Re-query issue authority immediately before commit/finalization and again after push before closure.

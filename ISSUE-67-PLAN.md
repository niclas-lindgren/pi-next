# Plan: Issue #67

## Authority snapshot

- Issue: #67, `fix(plan-recovery): repair or replan owned PLAN tasks missing Files/Approach instead of permanently containing a ready issue`
- Snapshot: 2026-08-21, open; unassigned; includes a post-release conformance comment identifying state persistence and fingerprint-budget gaps.
- Scope: correct pending PLAN-repair persistence, prove the real planning-only dispatch path, and reset bounded attempts when the invalid-plan fingerprint changes.

## Implementation slices

- Persist setting and clearing of `state.planRepair` to the run-scoped loop state file.
- Key repair attempts by the current pending-plan fingerprint while preserving same-fingerprint bounds and fail-closed ownership behavior.
- Add behavioral controller tests proving durable repair state, planning-only worker dispatch, fingerprint reset, and preservation of issue progress/workspace.

## Verification

- `npm run typecheck`
- `npm test`
- Focused plan-recovery/controller tests.

## Completion evidence

- Re-query issue authority immediately before candidate commit/finalization and again after push before closure.

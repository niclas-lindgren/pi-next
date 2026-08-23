# Issue #66 plan

## Authority snapshot

- Issue: #66, `fix(worktree-recovery): attribute legacy commits from canonical issue evidence, not only #N in commit messages`
- Snapshot: 2026-08-21, open; assigned to `niclas-lindgren`; no comments.
- Scope: bounded attribution of clean divergent legacy commits during canonical worktree recovery.

## Implementation slices

- Inspect each divergent commit's message and canonical workflow artifacts from its own committed tree.
- Accept literal `#N` evidence or an issue-matching PLAN/VERIFY identity only when no conflicting workflow identity is present.
- Reject ambiguous, foreign, or mixed commit sets before any worktree mutation, with evidence-rich diagnostics.
- Add regression coverage for canonical PLAN attribution, substantive changes, foreign/conflicting artifacts, mixed history, and preservation.

## Verification

- `npm run typecheck`
- `npm test`
- Focused `test/workspace-recovery.test.ts` coverage.

## Completion evidence

- Re-query issue authority immediately before commit/finalization and again after push before closure.

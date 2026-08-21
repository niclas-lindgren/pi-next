# Repository agent instructions

These instructions are mandatory for issue-oriented work in this repository.
Always process GitHub issues as a bounded, serial loop: implement one open issue,
land it safely, clean up its workspace, and then re-query the live issue queue
before selecting the next issue.

## Required issue loop

1. **Discover live work.** Query GitHub immediately before selecting work (for
   example, `gh issue list --state open --limit 100`). Do not rely on a stale
   issue list, local PLAN files, or memory. Follow the repository's configured
   priority and readiness labels/states.
2. **Isolate the issue.** Refresh `main`, claim the issue through the configured
   authority, and work only in its canonical disposable worktree
   `.worktrees/issue-N` on `agent/issue-N`. Never implement issue work directly
   in the coordination checkout or on `main`.
3. **Plan, implement, and verify.** Read the issue and applicable repository
   policy, keep a durable issue plan, make the smallest complete change, and
   run the required typecheck/tests (plus issue-specific checks) before
   integration. A model's report or a checked plan is not completion evidence.
4. **Commit, merge, and push in that order.** Create a reviewable candidate
   commit on `agent/issue-N`. Use the guarded finalization path to re-check
   ownership, freshness, candidate identity, and authority state; merge it into
   `main` without rewriting history; push `main` to `origin`; and prove the
   candidate is reachable from `origin/main`. Never force-push. Do not close or
   mark the issue complete before the pushed integration is proven.
5. **Close through authority.** After the pushed commit and final verification
   are current, close the GitHub issue (or use the configured authority's
   completion operation) and leave a useful closing comment when appropriate.
   If authority or verification changed, leave the issue open and preserve the
   recovery evidence instead of claiming success.
6. **Clean up only after integration.** Remove completed workflow artifacts and
   the local issue worktree/branch only after the worktree is clean, no active
   plan or verification artifact remains, and integration into `origin/main` is
   proven. Preserve the remote branch when it is useful for audit or recovery.
   Never delete dirty, unintegrated, foreign, or ambiguous workspaces.
7. **Continue safely.** Re-query open GitHub issues after every completed or
   explicitly deferred issue. Continue only for an issue-local, safely released
   failure; stop for ownership, authority, verification, merge, push, or other
   loop-global failures. At exhaustion, report what was completed, deferred,
   or blocked and leave `git status` clean.

Prefer `/pi-next auto` for this loop. For manual operation, use the same
sequence and the coordination/finalization tooling; do not replace its safety
checks with ad-hoc `git merge`, `git push --force`, issue closure, or workspace
deletion commands.

## Repository checks

Before handing off any change, run:

```sh
npm run typecheck
npm test
```

Keep commits focused and update tests/documentation for behavior changes. Do
not expose credentials, tokens, prompts, transcripts, or private issue data.

# Claude Code

Read [`AGENTS.md`](AGENTS.md) first. It is the authoritative harness-neutral repository instruction entry point for issue selection, ownership, worktree isolation, implementation, verification, finalization, cleanup, and recovery.

For issue-oriented work, follow that workflow exactly: GitHub is the canonical live issue authority, use authenticated `gh` to discover and re-read issues and comments at the required lifecycle boundaries, and do not replace the repository's guarded issue/worktree/finalization machinery with ad-hoc Claude-specific behavior.

Claude may be used as a worker harness only within the repository's worker-adapter boundary. Do not let Claude-specific session or tool behavior become lifecycle authority, bypass ownership checks, weaken verification, or redefine the shared kernel semantics documented in `AGENTS.md` and the referenced worker/lifecycle documentation.

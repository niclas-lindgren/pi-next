# Bootstrap self-host supervisor

The bootstrap supervisor is a developer utility used while pi-next's worker-neutral evaluation/reliability program is being implemented.

Run one issue at a time from a clean `main` checkout:

```sh
npm run bootstrap:self-host -- --issue N
```

The supervisor creates/reuses the canonical `.worktrees/issue-N` worktree and launches a fresh plain-Pi implementation worker. It then runs deterministic checks outside the worker. Optional bounded repair/review modes may be enabled explicitly.

## Operator feedback contract

A long-running bootstrap run must be observable while it is executing. The terminal should emit bounded progress events for major phases such as repository preflight, worktree preparation, issue fetch, worker launch, worker/tool activity heartbeat, deterministic checks, repair/review, and terminal disposition. Progress output must never include prompts, hidden reasoning, secrets, or full transcripts.

The final machine-readable report remains the authoritative summary, but it must not be the first visible output of a potentially long run.

Until live progress rendering is implemented, a running worker may appear silent even though it is progressing. The canonical worktree can be inspected from another terminal with non-mutating commands such as:

```sh
git -C .worktrees/issue-N status --short
git -C .worktrees/issue-N log --oneline --decorate -5
```

Do not mutate, reset, clean, or delete the worktree while the bootstrap supervisor is active.

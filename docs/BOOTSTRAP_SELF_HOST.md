# Bootstrap self-host supervisor

The bootstrap supervisor is a developer utility used while pi-next's worker-neutral evaluation/reliability program is being implemented.

Run one issue at a time from a clean `main` checkout. Omitting `--issue` mechanically selects one dependency-ready item from the configured self-host roadmap using live GitHub issue state; no worker/model is asked to choose work.

```sh
npm run bootstrap:self-host
npm run bootstrap:self-host -- --issue N
npm run bootstrap:self-host -- --next-only
```

`--issue N` remains an explicit operator override. `--next-only` performs roadmap discovery and reports the selected issue plus bounded skip/block reasons without launching a worker/model or mutating GitHub.

After an issue number is resolved, the supervisor creates/reuses the canonical `.worktrees/issue-N` worktree and launches a fresh plain-Pi implementation worker. It then runs deterministic checks outside the worker. If implementation completed, candidate work exists, and deterministic verification fails with bounded evidence, normal self-host operation launches at most one fresh repair worker automatically, reruns verification, and continues to finalization on success. Use `--no-repair` to opt out; `--repair` remains a compatibility alias for the default. Optional review may be enabled explicitly. One invocation still executes at most one issue; automatic selection is not queue progression.

## Operator feedback contract

A long-running bootstrap run must be observable while it is executing. The terminal should emit bounded progress events for major phases such as repository preflight, worktree preparation, issue fetch, worker launch, worker/tool activity heartbeat, deterministic checks, repair/review, and terminal disposition. Progress output must never include prompts, hidden reasoning, secrets, or full transcripts.

The final machine-readable report remains the authoritative summary on stdout. Human progress is rendered separately on stderr so callers can continue to parse the final JSON without interleaved status lines. Silent workers and long-running deterministic checks emit bounded periodic heartbeats.

The canonical worktree can also be inspected from another terminal with non-mutating commands such as:

```sh
git -C .worktrees/issue-N status --short
git -C .worktrees/issue-N log --oneline --decorate -5
```

Do not mutate, reset, clean, or delete the worktree while the bootstrap supervisor is active.

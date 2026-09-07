# Issue #174 fresh-process consumer smoke

Date: 2026-09-07

## Scope

This records the repository-visible recovery evidence requested after #174 was reopened. The implementation candidate was already integrated on `main`; this smoke verifies the released generation from a fresh Pi process in a disposable consumer checkout and records foreground `/pi-next auto` observability.

## Release qualification checked first

- `main` Release gate for `ecc8bfe401ad3dbb4664e0d3af1759c1afd0ec4d`: success — https://github.com/niclas-lindgren/pi-next/actions/runs/34126784181
- `v0.3.10` Release gate for `ecc8bfe401ad3dbb4664e0d3af1759c1afd0ec4d`: success — https://github.com/niclas-lindgren/pi-next/actions/runs/34126784328

## Smoke setup

- Disposable consumer repository with a local bare `origin`; no hosted consumer remote or deployment trigger.
- Fresh Pi host process: `pi --mode rpc --no-session --offline --approve`.
- Pi-next installed through Pi package loading from a git source pinned to `ecc8bfe401ad3dbb4664e0d3af1759c1afd0ec4d`.
- Authority transport was a bounded local `gh` stub that exposed one ready, low-risk work item `#9001` and exercised the GitHub authority/lease command paths without mutating a real repository.
- Footer/TUI live widget was unavailable because the run used RPC mode; foreground `notify` events were the observed surface.
- Provider credentials were intentionally unavailable/offline. The expected result was an intelligible worker failure after launch, not a silent or hanging command.

## Observed foreground transcript

```text
Pi-next auto · START
Pi-next auto · selecting work
selected #9001
#9001 · claim · START · claim #9001
#9001 · claim · PASS · claim #9001
#9001 · preflight · START
#9001 · worker · START
#9001 · preflight · START
#9001 · preflight · PASS
#9001 · worktree · START
#9001 · worktree · READY · .worktrees/issue-9001
#9001 · dependencies · START
#9001 · dependencies · READY · not-required
#9001 · issue · START
#9001 · issue · READY
#9001 · context · implementation · READY · context budget ~245 tokens (977/256000 bytes); top: dispatch prompt overhead kernel-overhead ~202 tokens; #9001 body issue-body ~22 tokens; AGENTS.md repository-instructions ~11 tokens; #9001 title is
#9001 · worker · START · factory
#9001 · worker · READY · factory
#9001 · worker · implementation · START
#9001 · worker · implementation · READY · calls=0 · elapsed=0ms
#9001 · worker · implementation · HEARTBEAT · calls=0 · rounds=0 · tokens=0 (fresh=0 cache=0 out=0) · elapsed=1s
#9001 · worker · implementation · FAIL · calls=0 · rounds=0 · tokens=0 (fresh=0 cache=0 out=0) · elapsed=1s · work worker failure: No [REDACTED] for the selected model. Use /login to log into a provider via OAuth or [REDACTED] See: $1[PATH] $1[PATH]
#9001 · verification · npm run typecheck · START
#9001 · verification · npm run typecheck · PASS · elapsed=56ms
#9001 · verification · npm test · START
#9001 · verification · npm test · PASS · elapsed=56ms
#9001 · terminal · FAIL · no candidate changes were produced and satisfaction was not mechanically proven; workers=1; rounds=0; calls=0; tokens=unavailable; input=0; output=0; cache-read=0
#9001 · finalization · SKIPPED · not-ready
Pi-next auto · issue #9001 result blocked
Pi-next auto · re-querying authority
Pi-next auto · continuing to next issue
Pi-next auto · selecting work
Pi-next auto · candidate queue exhausted
Pi-next auto · COMPLETED · 1/50 settled · workers=1 rounds=0 calls=0 tokens=unavailable
```

## Assertions from the smoke harness

- Installed package head equaled the pinned release commit `ecc8bfe401ad3dbb4664e0d3af1759c1afd0ec4d`.
- The first foreground message was `Pi-next auto · START`.
- Selection/discovery was visible before claim and worker launch.
- The exact selected issue identity `#9001` was emitted before claim and worker launch.
- Claim start/pass, preflight, worktree, dependency, context budget, worker start/ready/heartbeat/fail, verification, finalization skipped, re-query, continuation, exhaustion, and terminal summary were all visible as foreground notifications.
- The command ended with one bounded typed terminal summary.
- The disposable consumer checkout was clean after the run; `.pi/git`, `.pi/runtime`, and `.worktrees` were ignored smoke byproducts.

## Result

PASS for the #174 recovery boundary: the v0.3.10 generation starts visibly in a fresh consumer Pi process, selects and executes a bounded issue lifecycle, exposes worker/activity/token context progress without a footer/live widget, and fails intelligibly when the worker provider is unavailable instead of appearing dead.

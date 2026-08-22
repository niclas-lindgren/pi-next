# Pi host session and worker lifecycle

This document records the runtime boundary Pi-next must use when it needs fresh
model context. It exists to prevent repeated fixes that treat Pi host-session
replacement as an ordinary worker-rotation primitive.

## Decision

**Normal `/pi-next auto` execution keeps one stable parent Pi host session.**

Fresh planning, implementation, repair, review, verification, and maintenance
model context belongs in Pi-next's isolated child worker processes. Pi-next must
not call `ctx.newSession()` merely because a worker turn, controller batch,
maintenance step, or issue boundary completed.

The normal shape is:

```text
one interactive Pi host session
└── one long-lived /pi-next auto supervisor
    ├── stable controller/footer ownership
    ├── scheduler and durable run state
    ├── isolated planning worker process
    ├── isolated implementation worker process
    ├── isolated repair/review/verification worker processes
    └── further isolated workers as needed
```

A worker gets freshness by starting as a new isolated Pi child and rebuilding
its task from the canonical worktree, configured workflow artifacts, current
authority, and explicit worker-dispatch contract. Keeping the parent host
session alive must never mean carrying a previous issue's model conversation,
PLAN assumptions, or authority snapshot into a later worker.

## Why `ctx.newSession()` is the wrong normal boundary

This is based on Pi's current public runtime contract and implementation,
reviewed on 2026-08-21.

Pi's `AgentSessionRuntime` owns replacement of the active `AgentSession` for
`newSession()`, `switchSession()`, `fork()`, clone/import flows, and similar
host lifecycle operations. Its replacement path settles/aborts the current
session, emits `session_shutdown`, invokes the host pre-invalidation hook,
disposes the current session, constructs/applies the replacement runtime, then
rebinds the replacement session.

Primary upstream references:

- `AgentSessionRuntime` replacement implementation:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts>
- extension replacement-context API (`ReplacedSessionContext`, `withSession`):
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts>
- SDK guidance: use `AgentSessionRuntime` when intentionally replacing the
  active session, and rebind session-local subscriptions afterward:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/13-session-runtime.ts>
- extension handoff example: after `ctx.newSession()`, the original `ctx` is
  stale and post-switch work must use the replacement context:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/handoff.ts>

Interactive Pi wires its pre-invalidation hook to `resetExtensionUI()`. That
reset clears extension-owned footer/header/widgets and extension status entries
before the old session is invalidated. Therefore an extension cannot promise
atomic, zero-frame continuity of `ctx.ui.setStatus()` across a genuine Pi
runtime replacement.

Relevant implementation:

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts>

Upstream also rejected a request to add a `silent` `newSession()` option whose
purpose was suppressing replacement UX:

- <https://github.com/earendil-works/pi/issues/4912>

The practical contract is therefore:

> `ctx.newSession()` is a host-runtime replacement primitive, not a cheap
> fresh-model-context primitive.

## Normal Pi-next lifecycle

During an uninterrupted `/pi-next auto` run:

1. The foreground supervisor is bound to the current live parent Pi command
   context.
2. Scheduler/authority/worktree decisions happen in the parent controller.
3. Every model turn that needs fresh context runs through the isolated child
   worker process contract.
4. Child workers receive only the explicit task/role/config/authority/worktree
   inputs required for that turn.
5. When a child settles, the parent controller consumes durable results and may
   launch another fresh child without replacing the parent Pi session.
6. Issue changes, scheduler-only cycles, maintenance, convergence yields, and
   recovery reconciliation do not by themselves create a new Pi host session.

This keeps host UI ownership stable and avoids rebuilding/discarding complete Pi
session graphs simply to obtain a fresh model worker.

## Genuine host replacement

A real Pi session replacement can still happen because the user or Pi performs
an operation such as `/new`, resume/switch, fork, reload, or another lifecycle
transition.

When that happens:

- the old `ExtensionCommandContext` is stale after replacement and must never
  be used for host/UI calls;
- `withSession` / the replacement context is the supported continuation
  boundary when the initiating command owns the replacement;
- extension/runtime state that is safe to continue must be rebound to the new
  context;
- durable run, lease, canonical worktree, PLAN, VERIFY, and recovery evidence
  remain the source of continuity;
- if safe continuation cannot be proven, settle/preserve and use normal restart
  recovery rather than guessing;
- UI may visibly reset during the genuine replacement because Pi explicitly
  clears extension UI; restoring it at the earliest supported new-session
  boundary is correct, but zero-blank-frame continuity is not an extension
  invariant.

`setLiveCtx()` / `getLiveCtx()` exist for this exceptional host-lifecycle
rebinding and for callbacks that must resolve the currently valid context. They
must not be used as justification for manufacturing routine host replacements.

## Memory implications

Pi-next previously rotated the parent host session aggressively while keeping a
long-lived supervisor. This created multiple retention surfaces around old
contexts, session graphs, listeners, timers, displays, and status bindings, and
contributed to the parent-memory work tracked in #69.

The stable-host architecture is the baseline that memory diagnostics must now
measure. A representative long-run test should execute many isolated worker and
controller transitions in one parent Pi host session and verify that retained
parent memory reaches a bounded envelope rather than growing with transition
count.

The memory-pressure `restart_required` safety fence remains necessary until
bounded behavior is proven. Raising V8's heap limit is not a substitute for
fixing retained growth.

## Telemetry terminology

Do not call a worker transition, controller batch, or issue transition a
"session" unless an actual Pi host `AgentSession` was replaced.

Telemetry should distinguish:

- **host session** — actual Pi runtime/session identity;
- **worker turn** — one isolated child model execution;
- **controller transition/batch** — bounded scheduler/controller work, if that
  concept remains useful;
- **issue transition** — change in durable issue lifecycle state.

A normal uninterrupted auto run can execute many worker turns and issue
transitions while remaining in one host session.

## Regression invariant

Any future scheduling, lifecycle, memory, footer, or context change must include
an outer-path regression proving that ordinary auto progression does not
initiate a Pi host-session replacement.

At minimum, representative tests should establish:

```text
20+ ordinary worker/controller transitions
-> fresh isolated child workers as required
-> same parent host session identity
-> zero Pi-next-initiated ctx.newSession() calls
```

Separate tests should exercise a genuine externally initiated host replacement
and prove that stale contexts are not reused.

## Related issues

- #72 — architectural implementation owner: stable parent host session and
  isolated child freshness.
- #69 — prove bounded parent memory under the stable-host architecture and keep
  safe pre-OOM recovery.
- #70 — superseded footer-handoff approach; Pi intentionally clears extension
  UI during actual host replacement.
- #11 — artifact-first context pruning, complementary to child-worker freshness.

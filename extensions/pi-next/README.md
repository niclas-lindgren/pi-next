# pi-next extension

`pi-next` is the autonomous issue-implementation loop extension for the
pi-coding-agent host. The foreground supervisor owns one auto run and its
isolated disposable workers; durable recovery remains lease- and worktree-
authority-first.

## Supervisor-scoped worker lifecycle

An `ExtensionGeneration` (`util-core.ts`) is the unit of lifecycle ownership
for one worker turn. A `SupervisorRuntime` (`supervisor-runtime.ts`) belongs to
exactly one `ForegroundSupervisor` and owns that supervisor's current
`ExtensionGeneration`. A replacement generation is bounded and awaited before
that same supervisor starts another turn. There is no process-global active
worker generation, so concurrent supervisors cannot dispose one another's
workers.

`currentGeneration()` is only a compatibility view of the runtime carried by
the current async supervisor context. Outside that context it returns no
worker; direct commands must not observe or dispose another run's worker.

### Lifecycle contract

1. `ForegroundSupervisor.launch()` establishes the foreground runtime and
   drives the claim, canonical-worktree, isolated-child-worker, reconcile,
   release, and select-next flow through the owning runtime.
2. Every `ctx.newSession()` transition asks that same runtime to replace its
   generation. Replacement teardown is bounded; `isDisposed()` becomes true
   as teardown begins, and tracked subprocesses receive the generation abort
   signal.
3. `ForegroundSupervisor.abort()` tears down only its own runtime generation,
   marks only its own durable run stopped, and never resets, stashes, or
   commits issue-worktree edits.
4. Status separates durable controller state from actual live worker state.
   The live-supervisor registry is keyed by canonical `cwd` and `runId` and is
   diagnostic only; GitHub/shared lease CAS authority remains the ownership
   source of truth.
5. Restart recovery selects only the local run matching the fresh authoritative
   issue lease. Historical loop records, timestamps, stale controller files,
   and coordination-root continuation markers cannot claim ownership. Dirty
   canonical issue-worktree edits are preserved for the fresh worker to inspect.
6. Issue model turns run in dedicated OS worker processes via
   `runIssueWorker()`, with the canonical issue worktree passed as
   `spawn({ cwd })`; the parent never pins the shared process cwd.
7. Worker stdout/stderr is parsed incrementally by `worker-activity.ts` from
   Pi's own JSON event stream — including per-token `message_update`
   `text_delta` events for live visible-text streaming. Only normalized
   file/tool/test activity and redacted, allowlisted visible text cross the
   child boundary; raw NDJSON, prompts, tool payloads, and hidden
   thinking/reasoning deltas do not (#614).
8. `worker-display.ts` mutates a small in-memory `WorkerDisplayController`
   directly from that stream and renders it as a live `ctx.ui.setWidget`
   panel above the editor, so visible assistant text and tool activity
   appear while a child is still generating/working, not only once a full
   message/tool call has completed. `work-log.ts` separately appends only
   completed, bounded events (`pi-next-worker-log` custom entries) as
   durable transcript history; `/pi-next-view` filters both the live panel
   and the durable transcript the same way. Footer heartbeats and the live
   panel's own bounded fallback heartbeat are supplemental, and status
   reports `worker liveness unknown` unless a live child runtime callback
   has confirmed the process.

Command-level notifications remain best effort and are not generation-gated
when they describe claim/worktree failures or lease diagnostics outside a
worker lifetime. Worker progress, subprocesses, queued follow-up delivery, and
other generation-owned callbacks use the owning runtime's abort/disposal
boundary.

### Transport invariant

Child-process/worktree isolation and live display delivery are independently
valuable. Presentation changes must consume the existing owner-bound worker
display/event sink; they must not replace that transport with transcript
reconstruction, model-authored progress protocols, or process-global UI
ownership. Filtering changes presentation only and never changes worker
execution or callback ownership.

### Presentation verbosity (#617)

The live panel has two presentation-only densities, selected via
`/pi-next-view compact | verbose | status`, orthogonal to the existing
`/pi-next-view all | off | #N | issue N | run <id>` issue/run filter:

- `verbose` (default): a larger bounded region per worker — elapsed runtime,
  the current visible assistant text, up to ~12 recent meaningful activity
  items (richer deterministic labels for pi-next's own tools, e.g. `pi_next_git`
  action `status` renders as "checking git status" rather than
  "using pi_next_git"), and a `last event Ns ago` liveness line.
- `compact`: the original small known-good baseline (issue/status header, up
  to 3 recent items, no elapsed/last-event lines) — kept as an explicit
  fallback/compatibility mode if the richer renderer ever causes host
  limitations.

Both densities render from the exact same `WorkerDisplayController` state and
event stream described above; verbosity changes only how much of that state
is shown and never the transport, event normalization, or worker lifecycle.
`WorkerDisplayState` always retains the larger (verbose) buffer internally so
toggling verbosity mid-run never loses already-buffered text/items — only the
rendered slice differs.

### Known-good manual smoke test

After `/reload` in an interactive Pi host, use synthetic issue/worker data and
run `/pi-next auto` while the child is still active. Confirm that:

1. `/pi-next-view status` reports the default `all` presentation and `verbose`
   density, and the live panel shows attributed assistant text and a
   tool-start entry before the child completes.
2. A deliberately quiet worker retains a bounded heartbeat/liveness indication
   (idle seconds in compact, a `last event Ns ago` line in verbose).
3. Filtering to one issue/run changes only what is shown; it does not stop or
   reroute the worker. `/pi-next-view compact` then `verbose` changes only
   density, with no effect on the worker.
4. Cancelling or reloading disposes the old display safely, and late callbacks
   do not appear in the replacement panel.

The known-good baseline is a live `#<issue> · <phase>` panel with tool activity
and a bounded `worker still running` heartbeat during the real
`/pi-next auto` command path. This smoke test complements the streaming and
attribution regression tests; parser replay alone is not sufficient evidence.

## Related

- `#583` — lifecycle safety and bounded teardown.
- `#591` — isolated issue workers and worktrees.
- `#612` — foreground supervisor architecture.
- `#614` — live worker display (`worker-display.ts`), superseding `#607`'s
  bespoke `pi_next_progress` narration protocol.
- `#617` — richer live worker console (verbose/compact presentation density)
  built downstream of `#614`'s transport without changing it.

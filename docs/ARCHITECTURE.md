# Architecture

Pi-next is an agent operating-system kernel hosted by Pi. It schedules bounded
workers around a live authority source; it is not a model provider, issue
tracker, deployment system, or repository policy bundle.

## Boundaries

### Consumer

The consumer owns `.pi-next/config.json`, repository policy entrypoints,
quality commands, model/provider policy, credentials, skills, deployment rules,
and any authority-specific adapter behavior.

### Authority adapter

An adapter discovers and fetches work items, normalizes identity and freshness,
and exposes capabilities such as completion or project status. Adapter output
is structured and validated. An adapter that cannot provide a required
capability fails at that boundary; local PLAN files never replace authority.
GitHub is the built-in adapter, while the in-memory adapter supports tests.

### Kernel

The kernel owns candidate scheduling, lease/CAS ownership, canonical
`.worktrees/issue-N` workspaces, durable loop transitions, process lifecycle,
verification sequencing, guarded completion, and bounded telemetry. A lease
is the ownership authority. A plan is a durable execution/recovery artifact
that must be reconciled with a fresh live authority lease before execution.

### Workers

Planning, implementation, and repair workers are mutable only inside the
already-owned canonical workspace. The parent process supplies the workspace
as the child process cwd. Host-supported reviewer restrictions should be used
where available, but Pi-next does not claim OS sandboxing by prompt convention.

## Lifecycle

```text
discover -> authority freshness -> lease CAS -> canonical worktree
  -> plan/implementation -> checkpoint/recovery -> verification
  -> current-authority reconciliation -> guarded completion
```

Any ownership, identity, freshness, worktree, verification, or integration
failure stops the transition. Completion is not inferred from a checked PLAN
checkbox or a model's prose response.

## Durable state and privacy

Consumer workflow artifacts use configured paths. Pi runtime/session data and
bounded diagnostics live under `.pi/`. Telemetry is for lifecycle evidence,
not transcript storage: prompts, hidden reasoning, raw logs, secrets, and
unnecessary authority content are excluded. Consumer-specific publication and
deployment decisions remain outside the kernel.

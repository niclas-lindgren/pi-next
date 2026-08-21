# Architecture

Pi-next is an agent operating-system kernel hosted by Pi. It schedules bounded
workers around a live authority source; it is not a model provider, issue
tracker, deployment system, or repository policy bundle.

## Design principle

**Pi-next is portable by default and extensible by design.**

Portable means generic Pi-next behavior works in a new consumer without
requiring that repository to copy historical helper scripts, product-specific
policy, labels, paths, or adapter glue merely to reproduce behavior the kernel
can provide itself. Generic capabilities should therefore have package-owned,
product-neutral defaults whenever Pi-next can implement them safely.

Extensible means repositories can deliberately replace or augment behavior at
versioned, validated boundaries when their semantics genuinely differ. An
extension point is not a requirement for every consumer to implement that
capability themselves.

The default precedence rule is:

```text
explicit configured consumer override -> validate -> authoritative for its contract
no configured override                 -> package-owned Pi-next default
```

The mere presence of a conventionally named file is not an override. This
prevents stale migration residue from silently changing runtime semantics. If a
consumer explicitly configures an override, that override is authoritative for
its defined contract; if it is missing, malformed, incompatible, or otherwise
invalid, Pi-next fails clearly at that boundary rather than silently falling
back to behavior the consumer intentionally replaced.

Extension authority is always scoped. A state provider may define workflow
state, an authority adapter may define work-item operations, and a verification
provider may define configured verification semantics, but none of them gains
ownership simply by being configured. Kernel invariants such as lease/CAS
ownership, canonical workspaces, freshness, guarded completion, and fail-closed
safety remain non-overridable unless the public kernel contract explicitly says
otherwise.

This gives a practical design test for new dependencies:

```text
Can Pi-next provide the generic behavior safely?
  yes -> ship a portable built-in default

Can consumers reasonably need different semantics?
  yes -> expose an explicit validated extension point

Has the consumer explicitly selected an override?
  yes -> respect it as authoritative within that contract
  no  -> use the built-in default
```

## Boundaries

### Consumer

The consumer owns `.pi-next/config.json`, repository policy entrypoints,
quality commands, model/provider policy, credentials, skills, deployment rules,
and any explicitly configured consumer extensions or authority-specific adapter
behavior. Consumers do not need to reimplement generic kernel behavior merely
because an extension point exists.

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

Candidate discovery is a bounded scheduler boundary. The GitHub adapter uses timed priority queries, lease reads are inspected in
small progressive windows with capped concurrency, and refresh/lease
subprocesses are cancellable. A
selection deadline reports `candidate_discovery_unavailable` with elapsed and
last-progress diagnostics rather than leaving a stable supervisor in an
unobservable await. `PI_NEXT_AUTHORITY_TIMEOUT_MS` overrides the default
per-operation timeout when a deployment needs a different authority budget.

Guarded completion (`src/coordination/finalize.ts`, exposed by the
`finalize` command in `src/coordination/cli.ts`) integrates one verified
`agent/issue-N` candidate commit into `main` and closes the work item only
if the lease is still freshly owned, the candidate is still the branch tip,
the merge/push lands without a force-push, the pushed candidate is provably
reachable from `origin/main`, and the live work item is unchanged since
verification. The close/comment step goes through the injected
`WorkAuthorityAdapter` (`capabilities.completion`), so this stays
authority-adapter-agnostic; git integration has no GitHub dependency.
Consumers may instead supply explicit structured pending-verification criteria;
adapters that advertise `capabilities.pendingVerification` durably record those
criteria and the exact integrated main revision while leaving the work item open.
Integration can land durably even when closure is withheld
(`requiresReverification`, `authorityChanged`, `leaseLostAfterMerge`) --
main is never held hostage by a stale verification snapshot, but a stale
worker can never silently mark stale-authority work "Done".

A `requiresReverification: true` result's `mergeSha` is the exact integrated
main revision the caller must reverify before retrying. The retry must pass
that same SHA back as `verifiedIntegratedMain` (#20): candidate reachability
from `origin/main` alone is never sufficient proof the *current* integrated
tree is the one that was reverified, since an unrelated commit can land
between the caller's verification and the retry. A retry whose proof no
longer matches the live integrated main returns `requiresReverification:
true` again with the new state to verify, rather than closing on stale
evidence.

### Workers

Planning, implementation, and repair workers are mutable only inside the
already-owned canonical workspace. The parent process supplies the workspace
as the child process cwd. Host-supported reviewer restrictions should be used
where available, but Pi-next does not claim OS sandboxing by prompt convention.

An owned canonical PLAN with only missing task `Files:`/`Approach:` metadata is
not immediately contained. Mechanical and live-authority reconciliation run
first, then the controller may launch at most two bounded planning-only repair
turns. The repair prompt is restricted to the configured workflow artifact and
must preserve requirements, completed progress, logs, and dirty issue-local
work. The PLAN is validated again before any implementation worker can run;
foreign, ambiguous, or other structurally unsafe artifacts remain fail-closed.

## Extension contracts

Extension points should be explicit in versioned configuration or adapter
capabilities and should follow the same resolver semantics wherever practical:

1. select an explicitly configured override only when the configuration says to;
2. validate its capability/schema before mutation or expensive model work;
3. treat a valid selected override as authoritative for the narrow contract it
   implements;
4. otherwise use the package-owned default;
5. never silently fall back after an explicitly selected override fails; and
6. never infer authority from a file merely existing at a legacy/conventional
   path.

Package-owned defaults should consume generic configured paths and contracts,
not hard-code one consumer's repository layout. External helpers/providers must
use bounded input/output, cancellation/timeouts where applicable, and typed
failure classification. Their failure must not be mislabeled as an ownership
or worktree conflict when the actual boundary is configuration/integration.

## Lifecycle

```text
discover -> authority freshness -> lease CAS -> canonical worktree
  -> plan/implementation -> checkpoint/recovery -> verification
  -> current-authority reconciliation -> guarded completion
```

Any ownership, identity, freshness, worktree, verification, or integration
failure stops the transition. Completion is not inferred from a checked PLAN
checkbox or a model's prose response.

## Runtime feedback

Typed failures can be converted to bounded sanitized feedback events through
`src/coordination/feedback.ts`. Fingerprints omit run IDs, timestamps, paths,
and incidental numbers; recurrence is bounded and sinks are optional. Sink
failures cannot affect ownership, repository mutation, or the controller.
Consumers decide whether and where escalated events become external issues.

## Durable state and privacy

The coordination checkout is read/coordination-only for issue work. After lease
acquisition, PLAN, VERIFY, checkpoints, implementation, and issue lifecycle
artifacts resolve from the canonical `.worktrees/issue-N` workspace. Root
workflow files are treated as legacy/recovery debris rather than ownership
authority; safe inherited-artifact quarantine remains defense-in-depth.

Consumer workflow artifacts use configured paths. Pi runtime/session data and
bounded diagnostics live under `.pi/`. Telemetry is for lifecycle evidence,
not transcript storage: prompts, hidden reasoning, raw logs, secrets, and
unnecessary authority content are excluded. Consumer-specific publication and
deployment decisions remain outside the kernel.

# Worker adapter contract

Pi-next is a lifecycle and authority supervisor. A coding harness is an execution adapter, not the identity of the system.

Pi is the current built-in/default worker host because it is small, programmable, provider-neutral, and already integrated. The kernel must not depend on Pi-specific process/session semantics above the worker-adapter boundary. Alternative workers such as mini-SWE-agent, Codex, or Claude may be evaluated and added without changing authority, ownership, planning, verification, promotion, recovery, or completion semantics.

## Core rule

```text
pi-next kernel
  owns authority, leases, canonical workspaces, durable lifecycle,
  verification, recovery, finalization, and telemetry
        |
        v
worker adapter
  executes one bounded role in one already-authorized workspace
        |
        +-- Pi (default/current)
        +-- Codex CLI (explicit evaluation candidate)
        +-- mini-SWE-agent / Claude (deferred evaluation candidates)
        +-- other explicit adapters
```

A worker never becomes authoritative because it can edit files, run commands, or report success.

## Stable input contract

The adapter receives a bounded task packet derived mechanically from kernel state. Exact TypeScript names may evolve, but the public semantics are:

- dispatch version;
- role and capability profile;
- canonical workspace/cwd;
- work-item identity;
- authority fingerprint/snapshot binding where applicable;
- candidate/fixed-point binding where applicable;
- objective and currently authoritative requirements needed for the role;
- configured workflow artifact paths;
- selected model/thinking policy when the adapter supports it;
- selected methodology/skill hints;
- bounded verification commands or role-specific constraints;
- execution budget/cancellation signal;
- structured output contract.

Do not send the worker the entire pi-next lifecycle manual merely to make it obey mechanical kernel rules. Ownership, lease renewal, authority freshness, promotion, closure, and cleanup should stay out of worker prompts whenever the kernel can enforce them mechanically.

## Stable output contract

A worker result is evidence, not lifecycle authority. It should expose only what the kernel needs to continue safely, for example:

- adapter/harness identity and version;
- role;
- terminal execution disposition (`completed`, `failed`, `cancelled`, `timed_out`, or equivalent typed result);
- structured role result matching the dispatch output contract;
- bounded diagnostics;
- changed/candidate evidence that can be verified mechanically;
- token/cost/turn/command telemetry when available;
- exact dispatch binding so stale results can be rejected.

Raw prompts, hidden reasoning, full transcripts, secrets, and unbounded logs are not part of the durable worker contract.

## Adapter responsibilities

An adapter may:

- translate a kernel dispatch into harness-specific configuration/prompt/tool policy;
- start, stream, cancel, and terminate one worker execution;
- expose harness events as bounded provider-neutral worker events;
- collect usage/diagnostics supplied by the harness;
- implement harness-specific context minimization and tool restrictions.

An adapter must not:

- discover or claim work on its own;
- grant or infer ownership;
- choose a different canonical workspace;
- weaken live-authority reconciliation;
- close work items or mark project status complete;
- merge/push/promote work outside the guarded kernel path;
- treat model prose as verification evidence where a mechanical verifier exists;
- silently continue after cancellation or ownership loss;
- mutate unrelated work-items or the coordination checkout.

## Pi adapter

Pi remains the default adapter until evaluation shows another worker has a materially better verified-completion profile for supported workloads.

Pi-specific parent-session behavior is an implementation detail of the Pi adapter. The kernel contract requires fresh bounded worker context; it does not require Pi `ctx.newSession()`, Pi child processes, or any other Pi-specific lifecycle primitive.

## Alternative adapters

Alternative adapters are opt-in and must be added behind the same contract. They must first pass deterministic protocol/integration tests and then the independent agent-evaluation corpus.

Codex CLI is the first issue-#84 challenger adapter. It wraps one `codex exec` invocation in an already-authorized workspace, forces unattended operation, refuses authority-expanding sandbox/approval options, and normalizes JSONL usage/activity into the same worker result schema. It is selected explicitly with `PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter codex-cli`; it is not a production default.

mini-SWE-agent and Claude may follow if their installation/API surfaces can preserve the same bounded kernel contract with acceptable operational friction. Native harness/model optimization is a legitimate reason to outperform Pi, but not a reason to move lifecycle authority into the harness.

## Selection policy

Do not implement adaptive worker routing before there is evaluation evidence. Initial policy:

1. Pi is the default production worker.
2. Alternative adapters are explicit experiments/canaries.
3. Compare workers using the same task fixtures and independent grader.
4. Optimize for verified completion, not raw token count or model self-report.
5. A future default change requires a documented evaluation showing materially better reliability/cost/latency without weakening kernel control.

Useful primary metrics are:

- verified acceptance pass rate;
- tokens and cost per verified completion;
- wall time per verified completion;
- retries/escalations;
- command/turn count;
- regressions introduced;
- required pi-next intervention/recovery;
- context growth and cache efficiency where observable.

## Compatibility

Worker-adapter evolution must not change persisted authority/lease/workspace semantics implicitly. Adapter-specific runtime state is disposable unless explicitly versioned. A worker result from an old/incompatible dispatch contract must fail closed rather than being replayed against new semantics.

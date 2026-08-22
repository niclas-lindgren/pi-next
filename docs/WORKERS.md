# Worker dispatch

Pi-next resolves a versioned **harness-neutral worker contract** before launching an execution adapter. The contract binds a lifecycle role, optional model/thinking policy, selected engineering skills, capability profile, authority/candidate identity, and a bounded output contract. The worker cannot choose its own role from prose.

Pi is the current built-in/default execution adapter, not the architectural identity of pi-next. The kernel must be able to execute the same bounded dispatch through another adapter without moving authority, ownership, verification, recovery, promotion, or completion semantics into that harness. See [`WORKER_ADAPTER.md`](WORKER_ADAPTER.md).

Roles are derived from controller state: planning, implementation, repair, review-spec, review-standards, verification, maintenance, and controller. Review roles use an isolated read-only-reviewer capability profile; owner roles use mutable-owner only after the normal lease and canonical-worktree checks. Harness-supported reviewer restrictions should be used where available; no adapter may claim OS sandboxing merely by prompt convention.

## Worker adapter boundary

The controller supplies one bounded task packet to an adapter after the required authority/workspace checks. The adapter translates that packet into harness-specific process/session/tool configuration, streams bounded events/diagnostics, supports cancellation, and returns a structured result bound to the exact dispatch.

The adapter does **not** discover/claim work, select another workspace, close authority items, promote code, weaken verification, or infer lifecycle success from model prose. These remain kernel responsibilities.

Initial adapter policy:

1. Pi remains the production/default adapter.
2. mini-SWE-agent is the first experimental implementation adapter because it provides an independent, deliberately small harness comparison.
3. Codex and Claude adapters are later evaluation candidates when a small adapter can preserve the same contract.
4. No adaptive routing is introduced until independent evaluation data exists.
5. A default-worker change requires measured improvement in verified completion/cost/latency without weakening kernel control.

## Worker freshness vs. host sessions

A fresh bounded worker execution is pi-next's normal **fresh model-context boundary**. Planning, implementation, repair, review, verification, and other model turns must reconstruct the current task from explicit dispatch inputs, the canonical worktree, configured workflow artifacts, and fresh authority rather than inheriting a previous issue's conversational state.

For the Pi adapter today, this is implemented with isolated child Pi worker processes. The parent `/pi-next auto` Pi host session is a separate lifecycle boundary and should normally remain stable across worker turns, issue changes, scheduler cycles, and maintenance. Do not call `ctx.newSession()` merely to obtain a fresh worker. Pi's session-replacement APIs tear down and replace the active host runtime; they are reserved for genuine Pi/user lifecycle operations.

This Pi-specific mechanism is not part of the generic worker contract. Another adapter may provide isolation differently as long as it satisfies the same freshness, cancellation, workspace, and result-binding invariants.

See [`HOST_SESSION_LIFECYCLE.md`](HOST_SESSION_LIFECYCLE.md) for the Pi host contract, replacement semantics, memory/UI implications, and required regression invariant.

Methodology is selective. TDD, bug diagnosis, code review, and codebase design are loaded only for roles/tasks that need them. Skills are advisory and never define authority, ownership, promotion, or closure.

Consumers may configure provider-neutral model routing under `.pi-next/config.json`:

```json
{
  "workerDispatch": {
    "version": 1,
    "models": {
      "planning": { "model": "provider/model", "thinking": "medium" },
      "verification": { "model": "provider/strong-model", "thinking": "high" }
    },
    "maxEscalations": 2
  }
}
```

Model identifiers are examples and are not bundled defaults. Unknown roles, unsupported thinking levels, and unbounded escalation values fail closed. Bounded role, adapter/harness identity, skill, capability, usage, and result metadata may be retained in worker telemetry; prompts, hidden reasoning, raw transcripts, secrets, and unbounded logs are not.

## Evaluation

Worker quality is measured by an independent grader rather than worker self-report. Use the same repository/task fixtures across adapters and compare at least verified acceptance pass rate, tokens/cost per verified completion, wall time, retries/escalations, command/turn count, regressions, context growth/cache efficiency, and pi-next intervention/recovery.

The evaluation and reference-feature-harvest policy is defined in [`EVALUATION_AND_RELIABILITY.md`](EVALUATION_AND_RELIABILITY.md).

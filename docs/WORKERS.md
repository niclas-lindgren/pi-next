# Worker dispatch

Pi-next resolves a versioned **harness-neutral worker contract** before launching an execution adapter. The contract binds a lifecycle role, optional model/thinking policy, selected engineering skills, capability profile, authority/candidate identity, and a bounded output contract. The worker cannot choose its own role from prose.

Pi is the current built-in/default execution adapter, not the architectural identity of pi-next. The kernel must be able to execute the same bounded dispatch through another adapter without moving authority, ownership, verification, recovery, promotion, or completion semantics into that harness. See [`WORKER_ADAPTER.md`](WORKER_ADAPTER.md).

Roles are derived from controller state: planning, implementation, repair, review-spec, review-standards, verification, maintenance, and controller. Review roles use an isolated read-only-reviewer capability profile; owner roles use mutable-owner only after the normal lease and canonical-worktree checks. Harness-supported reviewer restrictions should be used where available; no adapter may claim OS sandboxing merely by prompt convention. Mutable Pi workers launch with an explicit positive tool allowlist and receive `safe_bash`, a positive command runner with read-only Git and no GitHub CLI authority rather than Pi's raw built-in `bash`. Pi extension guards block built-in `write`/`edit` attempts against `.git` metadata, paths outside the canonical workspace, and runtime authority/result records; worker-triggered Git mutations disable hooks so a source edit, commit, or checkpoint cannot smuggle a push/close side effect through `pre-commit`/`pre-push`. Repository-controlled build/test launchers run in a detached no-`.git` execution copy inside an OS mount/network sandbox with credential/transport scrubbing and child-process Git/GH wrappers, so normal verification does not grant local main/ref mutation capability. When the host cannot provide that OS sandbox, those repository-controlled launchers fail closed instead of running unsandboxed.

Residual Pi-host limitation: these guards constrain the Pi worker's exposed tool paths, child command environment, and Git invocations; they are not a general same-user OS confinement proof for arbitrary future host tools or for controller-owned verification that intentionally executes candidate code outside the worker sandbox. New tools or unsandboxed controller execution paths must therefore be added fail-closed and independently reviewed before being represented as part of a mutable worker capability profile.

## Worker adapter boundary

The controller supplies one bounded task packet to an adapter after the required authority/workspace checks. The adapter translates that packet into harness-specific process/session/tool configuration, streams bounded events/diagnostics, supports cancellation, and returns a structured result bound to the exact dispatch.

The adapter does **not** discover/claim work, select another workspace, close authority items, promote code, weaken verification, or infer lifecycle success from model prose. These remain kernel responsibilities.

Initial adapter policy:

1. Pi remains the production/default adapter.
2. Codex CLI is available as the first issue-#84 non-Pi eval challenger because its headless CLI can be wrapped without giving it lifecycle authority.
3. mini-SWE-agent and Claude remain deferred evaluation candidates when their installation/API friction justifies another comparison.
4. No adaptive routing is introduced until independent evaluation data exists.
5. A default-worker change requires measured improvement in verified completion/cost/latency without weakening kernel control.

## Worker freshness vs. host sessions

A fresh bounded worker execution is pi-next's normal **fresh model-context boundary**. Planning, implementation, repair, review, verification, and other model turns must reconstruct the current task from explicit dispatch inputs, the canonical worktree, configured workflow artifacts, and fresh authority rather than inheriting a previous issue's conversational state.

For the Pi adapter today, this is implemented with isolated child Pi worker processes. The parent `/pi-next auto` Pi host session is a separate lifecycle boundary and should normally remain stable across worker turns, issue changes, scheduler cycles, and maintenance. Do not call `ctx.newSession()` merely to obtain a fresh worker. Pi's session-replacement APIs tear down and replace the active host runtime; they are reserved for genuine Pi/user lifecycle operations.

This Pi-specific mechanism is not part of the generic worker contract. Another adapter may provide isolation differently as long as it satisfies the same freshness, cancellation, workspace, and result-binding invariants.

See [`HOST_SESSION_LIFECYCLE.md`](HOST_SESSION_LIFECYCLE.md) for the Pi host contract, replacement semantics, memory/UI implications, and required regression invariant.

## Skill resolution

Methodology is selective. **Available does not mean loaded.** Pi-next may have a reviewed catalog of installed skills, while each worker receives only the subset resolved for its exact dispatch.

The kernel resolves skills before the adapter launches the worker. Selection may use deterministic signals such as:

- lifecycle role;
- work-item type/labels and exact requirements;
- relevant repository paths/components;
- language/framework;
- configured risk/domain class;
- repair/failure state;
- explicit consumer policy.

A skill policy may distinguish:

- **mandatory** disciplines for a lifecycle/risk boundary;
- **automatic** disciplines selected by role/task/risk rules;
- **explicit** disciplines that are available but require an operator/project/planning request.

Examples:

- planning -> codebase/domain design only when material;
- implementation -> TDD where appropriate;
- repair -> diagnosing-bugs (+ TDD at a regression seam);
- frontend changes -> frontend/browser verification disciplines when configured;
- review-spec -> spec review discipline;
- review-standards -> standards/design discipline;
- verification -> an explicit verification-before-completion discipline when configured;
- controller -> no engineering-method skill by default;
- maintenance -> performance/telemetry discipline.

No role receives all installed skills by default, and installed-but-unselected skills must consume no worker context. The resolver should reject or explicitly resolve overlapping automatic methodologies such as two TDD or two debugging skills instead of giving the worker competing instructions.

External skills remain methodology rather than workflow ownership. In particular, framework-level bootstrap/process instructions that attempt to own planning, worktrees, subagent execution, review, or completion must not silently wrap or replace the pi-next kernel. Useful individual disciplines may be adapted behind the same trust/authority boundary. See [`SKILLS.md`](SKILLS.md).

The dispatch should retain bounded provenance for each resolved skill: identifier, exact version/source, selection reason/rule, and optionally its measured context contribution. This allows evaluation to compare routing policies against verified outcome, retries, tokens/cost, and latency without storing raw prompts or hidden reasoning.

## Model routing

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

Skill-routing policies should be evaluated the same way: compare no/legacy routing against deterministic selective loading while holding model and fixtures stable. Do not keep a routing rule merely because it reduces context; it must improve or preserve verified-completion efficiency and kernel safety.

The evaluation and reference-feature-harvest policy is defined in [`EVALUATION_AND_RELIABILITY.md`](EVALUATION_AND_RELIABILITY.md).

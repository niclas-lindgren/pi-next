# Implementation plan: worker-neutral, evaluation-driven pi-next

## Goal

Finish the architectural separation already started in `src/coordination/worker-dispatch.ts`: pi-next is the authority/lifecycle kernel, while Pi is one replaceable worker adapter. At the same time, replace manual consumer dogfooding as the main debugging method with deterministic protocol tests, replay, fault injection, real-Git integration, and independently graded worker canaries.

The implementation should stay incremental. Do not rewrite the existing controller or introduce a large orchestration framework.

## Guiding constraints

- Preserve current authority, lease/CAS, canonical-worktree, freshness, verification, guarded-finalization, and fail-closed behavior.
- Pi remains the production/default worker until evidence justifies a change.
- Alternative harnesses are adapters, not new lifecycle owners.
- No LLM is required for protocol, recovery, concurrency, Git, or most finalization testing.
- Every real lifecycle defect should become a durable regression scenario.
- Harvest proven mechanisms from mature frameworks before inventing equivalents; record adopt/adapter/reject decisions in `EVALUATION_AND_RELIABILITY.md`.
- Avoid platform dependencies whose operational/runtime complexity exceeds the mechanism pi-next needs.

## Phase 0 — establish the baseline

Before changing runtime behavior:

1. Record the current test suite and important outer-path regressions.
2. Identify every Pi-specific reference above the current dispatch boundary.
3. Measure a small baseline of real worker tasks: completion, acceptance, tokens, time, retries, and intervention.
4. Freeze a small historical incident corpus from already-known failures.

Deliverable: a baseline report/fixture set, not a runtime rewrite.

## Phase 1 — explicit `WorkerAdapter` seam

Extract the process-specific execution side of the existing worker-dispatch vocabulary behind a small interface. Keep `WorkerDispatchPolicy` and role/capability classification provider-neutral.

Conceptual contract:

```ts
interface WorkerAdapter {
  readonly id: string;
  readonly version: string;
  run(input: WorkerTask, signal: AbortSignal): AsyncIterable<WorkerEvent>;
}
```

The exact API is implementation-defined. The important properties are:

- exact dispatch binding;
- canonical cwd supplied by the kernel;
- typed terminal disposition;
- bounded diagnostics/events;
- cancellation;
- usage telemetry when available;
- no authority/lease/promotion/closure operations inside the adapter.

Move existing child-Pi launch logic behind `PiWorkerAdapter` with no intended behavioral change.

Acceptance gate:

- existing Pi behavior passes unchanged through the new adapter;
- tests can inject a scripted adapter without spawning Pi;
- no kernel transition branches on Pi session/process details outside the Pi adapter.

## Phase 2 — scripted worker and deterministic scenario runner

Add a `ScriptedWorkerAdapter` for tests that can deterministically:

- complete with a structured result;
- edit/commit a fixture when requested;
- fail non-zero;
- time out;
- cancel;
- emit bounded events;
- return malformed/stale bindings for negative tests.

Create a scenario runner that composes fake/memory authority, scripted workers, controllable clock/faults, and disposable Git fixtures.

Start with historical failures, not synthetic completeness.

Acceptance gate: the important known controller failures can be reproduced without an LLM.

## Phase 3 — lifecycle checkpoints and fault injection

Introduce stable named checkpoints at mutation/recovery boundaries. In test mode, permit deterministic termination/failure at a checkpoint.

Run crash/restart tests across at least claim, workspace preparation, worker completion, candidate commit, promotion push, reachability proof, authority update, lease release, and cleanup.

Acceptance gate: restart after each supported injected failure reaches a safe idempotent outcome or a truthful fail-closed state without losing unique work.

## Phase 4 — typed durable event journal and replay

Add a small append-only lifecycle journal for durable facts required by recovery/replay. Do not turn it into transcript storage or a second authority database.

Build a replay command/library that can load a bounded incident fixture and run it against the current kernel.

Acceptance gate:

- process death after a durable side effect can be resumed without repeating it unsafely;
- historical incidents can be replayed deterministically;
- journal schema/version compatibility is tested;
- prompts, reasoning, secrets, and unbounded logs are excluded.

## Phase 5 — property/model-based lifecycle testing

Evaluate `fast-check` first. If its dependency/maintenance cost remains small, use model-based testing to generate lifecycle command sequences against a simplified reference model and shrink failures.

Initial invariants come from `EVALUATION_AND_RELIABILITY.md`.

Acceptance gate: thousands of generated state-transition sequences can run without model tokens and produce minimal reproducible failures when an invariant is intentionally broken.

## Phase 6 — real-Git integration harness

Exercise real branches/worktrees/bare remotes with scripted workers. No hosted remote, no Vercel/deployment triggers, no consumer repository mutation.

Add concurrency and partial-finalization cases around the actual coordination/finalizer entrypoints.

Acceptance gate: Git integration, reachability, cleanup, takeover, and idempotent retry behavior are tested through the highest practical production path.

## Phase 7 — independent worker-evaluation corpus

Adopt the SWE-bench principle: generation and grading are independent.

Create small versioned task fixtures with:

- repository starting commit/archive;
- authoritative task spec;
- hidden/mechanical grading assertions;
- lifecycle assertions;
- bounded budgets.

Run the same fixtures through worker adapters. A worker's own completion message has zero grading authority.

### First comparison

1. `PiWorkerAdapter` — production baseline.
2. `MiniSweWorkerAdapter` — first independent challenger.
3. Codex adapter later if the SDK boundary stays small.
4. Claude adapter later under the same rule.

Primary decision metric: **cost/tokens per verified completion**, with pass rate and correctness taking precedence over raw token minimization.

## Phase 8 — context/token improvements harvested from mature tools

Only after the evaluation corpus exists, test improvements such as:

- Aider-style bounded repository map/symbol context;
- minimal role-specific system prompts;
- smaller task packets that omit mechanical lifecycle policy;
- harness-native context compaction/caching where measurable;
- model/harness-specific edit strategies where they remain adapter-local.

Every optimization is A/B tested against the same corpus. Reject clever context machinery that does not improve verified completion efficiency.

## Phase 9 — release qualification and consumer smoke

Make release qualification progressively require:

```text
unit/typecheck
 -> protocol/model tests
 -> historical replay
 -> real-Git/fault integration
 -> small real-worker canaries
 -> disposable consumer compatibility smoke
```

Campsty or another valuable consumer should only be used after these layers pass. Consumer smoke installs the candidate in a disposable checkout and exercises doctor/status plus a scripted-worker lifecycle before real autonomous work.

## Feature-harvest workflow

For each mature framework/tool investigated, add a short record with:

- source/project and specific mechanism;
- problem it solves;
- invariant learned;
- evidence of maturity/usage when relevant;
- pi-next disposition: `adopt`, `adapter`, or `reject`;
- expected complexity/dependency cost;
- evaluation needed to prove value.

Useful ideas are expected to become implementation work. The harvest is not documentation-only research. Conversely, pi-next should not add a feature merely because another framework has it.

## Implementation executor strategy

### Recommended first experiment: mini-SWE-agent

Use mini-SWE-agent as an **implementation worker** for the early bounded phases, while keeping issue selection, acceptance, review, merge, and release outside it.

Why it is a good experiment here:

- it is deliberately small and therefore aligns with pi-next's lean philosophy;
- it is independent from Pi, which prevents us from validating Pi-specific assumptions using Pi itself;
- the early work is concrete TypeScript/refactoring/test-harness engineering rather than product-design ambiguity;
- its simple execution model is useful pressure on the new worker contract: if the task packet only works when interpreted by Pi-specific machinery, the abstraction is not clean enough.

Do **not** give mini-SWE-agent a broad autonomous mandate over `main`. Preferred workflow:

```text
one implementation issue
 -> canonical isolated branch/worktree
 -> mini-SWE executes bounded task
 -> independent tests/eval/review
 -> guarded integration
 -> next issue
```

For the first few phases, a human or existing trusted outer coordinator should sequence issues. Once the scenario/evaluation harness proves stable, the same worker adapter can be used in automated canaries and eventually autonomous implementation.

### Why not use pi-next itself as the only implementer initially

Dogfooding remains useful, but making the system under test the only controller/worker for its own reliability refactor creates circular evidence: a Pi-specific failure can prevent the mechanism intended to diagnose it from being built or tested. An independent small worker is therefore valuable as a second path.

### When to consider Codex or Claude

After `WorkerAdapter` and independent grading exist, add a challenger only when the adapter is small and the native harness/model may materially improve verified completion efficiency. Do not integrate another full lifecycle framework.

## Suggested implementation issue slices

1. WorkerAdapter interface + Pi adapter extraction, behavior-preserving.
2. Scripted worker + deterministic scenario runner.
3. Historical incident fixtures for current known failures.
4. Named lifecycle checkpoints + injected crash/restart tests.
5. Typed bounded event journal + replay.
6. fast-check reference model/property tests.
7. Real-Git integration/concurrency matrix.
8. Independent task/grader corpus.
9. Experimental mini-SWE adapter + baseline comparison.
10. Context/token experiment: bounded repo map/minimal task packets.
11. Release qualification + disposable consumer smoke.

Keep these slices independently reviewable. Do not combine the worker abstraction, event persistence, property testing, alternative harness integration, and context optimization into one large migration.

# Evaluation, replay, and reference-driven reliability

Pi-next should become cheaper to maintain as it matures. Valuable consumer repositories must not remain the primary test bench for kernel behavior.

The target loop is:

```text
real failure once
  -> capture bounded scenario/evidence
  -> deterministic reproduction
  -> fix
  -> generated lifecycle tests + replay
  -> independent agent canaries
  -> consumer upgrade
```

Most lifecycle failures do not require an LLM to reproduce. Lease races, stale authority, crash recovery, canonical-workspace selection, partial finalization, retry idempotence, pending verification, and upgrade compatibility should be exercised with scripted workers at effectively zero model-token cost.

## Reference-driven engineering

Before introducing a non-trivial lifecycle, persistence, evaluation, context-management, execution, or recovery mechanism:

1. inspect mature implementations of the same narrow problem;
2. record the invariant or implementation pattern worth adopting;
3. choose one disposition: **adopt**, **adapter**, or **reject**;
4. implement the smallest pi-next-specific mechanism that satisfies the useful invariant;
5. add regression evidence through the outermost affected pi-next path.

This is not a feature-parity exercise. Pi-next should harvest proven mechanisms while staying lean.

### Initial reference feature harvest

| Source | Feature/pattern to evaluate | Initial disposition |
| --- | --- | --- |
| mini-SWE-agent / SWE-agent | small Agent/Environment/Model separation; simple per-command execution; low harness overhead | adopt pattern; experimental worker adapter |
| SWE-bench | task fixture separated from independent grading; reproducible repository start state | adopt |
| Aider | token-budgeted repository map/context selection; mature edit/context strategies | evaluate and adopt only if it improves measured tokens per verified completion |
| OpenHands | typed append-only lifecycle events plus resumable current state | adopt the small event/replay pattern, not the platform |
| Temporal | idempotent durable transitions; external side effects separated from deterministic decisions | adopt invariants, not server/runtime dependency |
| fast-check | model/property testing with generated command sequences and shrinking | adopt direct dev dependency for lifecycle model tests; its `commands`/`asyncModelRun` API gives reviewed preconditioned model commands and automatic shrink output without a custom generator/shrinker |
| Codex | structured worker events/results; sandbox/security ideas; native model/harness optimization | evaluate behind adapter |
| Claude Agent SDK | structured headless worker execution and cancellation; native Claude optimization | evaluate behind adapter |

### Monitor wake-up decisions (issue #85)

- **adopt-pattern** — event-loop coalescing from small workflow schedulers: monitor mode keeps at most one in-flight scheduler execution and treats authority observations as wake hints. Changes that arrive while work is active are folded into the next authoritative selection pass instead of spawning a parallel lifecycle.
- **adopt-pattern** — bounded polling/backoff from rate-limit-aware clients: idle monitoring performs mechanical authority reads on a conservative cadence, switches to bounded exponential backoff for transient discovery failures, and performs a fresh full selector query after recovery rather than trusting cache hints.
- **adopt-pattern** — idle/session separation from agent harnesses: the long-lived parent host stores only bounded operational monitor state; every implementation still runs through the existing WorkerAdapter child-worker path.
- **adopt-pattern** — durable workflow wake semantics from Temporal/OpenHands: a wake-up is not ownership proof. The existing candidate selector and lease/CAS path remains authoritative after every wake.
- **reject** — importing a daemon, webhook server, or workflow-orchestration framework merely to poll an authority.

### Worker canary harness decisions (issue #81)

- **adopt** — SWE-bench's generator/grader separation: each canary builds a disposable fixture repository and task packet, invokes a `WorkerAdapter`, then runs hidden mechanical grader assertions. Worker terminal success or prose is recorded only as evidence and cannot mark PASS.
- **adopt-pattern** — mini-SWE-agent's small harness seam: the benchmark uses the existing provider-neutral `WorkerAdapter` contract so Pi, scripted tests, and later Codex/Claude/mini-SWE adapters can run the same fixtures unchanged.
- **adapter** — Pi SDK telemetry is normalized when exposed (`input`, `output`, cache tokens, total tokens, cost, model, tool calls). Unknown SDK surfaces remain optional rather than blocking grading.
- **adapter** — Codex/Claude SDK event metrics are reserved for later adapters behind the same result schema; their native token/cost/turn streams should be mapped to the common aggregate fields without moving lifecycle authority into those SDKs.
- **reject** — running real-worker canaries as part of ordinary `npm test`. The command is explicit and credential-gated (`PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter pi`), with conservative smoke mode available via `--smoke`.

The table is intentionally revisitable. New useful features discovered in mature frameworks should be added here before implementation so they are consciously adopted or rejected rather than rediscovered ad hoc.

### Worker context minimization decisions (issue #82)

- **adopt-pattern** — Aider's bounded repository-map/context-budget idea as a small structural sketch (`repo-map`) with an explicit byte/file budget. Pi-next does not build a vector database, whole-repository prompt, or second semantic codebase index.
- **adopt-pattern** — minimal fresh-worker packets from Pi/mini-SWE/Codex/Claude-style harnesses: child coding workers receive exact task, cwd and bounded checks, while kernel-owned lifecycle policy (leases, promotion, closure, cleanup, authority freshness) stays mechanically enforced rather than repeated in every prompt.
- **adopt-pattern** — task-aware lazy skill loading: the reviewed skill registry may grow, but available/unselected skills contribute zero worker-context payload. Results record available count, selected IDs, loaded contexts, reason tier, provenance/version, and estimated per-skill tokens.
- **adapter** — Matt Pocock methodology catalog is represented as composable skill entries selected by deterministic pi-next rules rather than loaded universally.
- **adapter** — Superpowers is evaluated only as individual disciplines such as verification-before-completion behind pi-next dispatch/trust boundaries. Its global bootstrap/process-owner workflow is not imported because that would change orchestration semantics rather than context selection.
- **reject** — universal always-on skills, pi-next controller/extension context in ordinary coding children, competing workflow bootstraps, and prompt-size-only optimizations that reduce tokens while degrading independent verified completion.

### Bootstrap auto-finalization recovery proof (issue #108)

- **adopt-pattern** — durable workflow systems separate side-effect completion evidence from incidental local resources. The bootstrap supervisor now treats `.git/pi-next/bootstrap-lifecycle/issue-N.verified-candidate.json` as a bounded exact-candidate proof only after deterministic finalizer verification records the candidate SHA, and still validates the live local branch before skipping an implementation worker. Mere branch/worktree existence remains non-authoritative and cannot bypass no-op candidate semantics.

### Bootstrap automatic bounded repair (issue #134)

- **adopt-pattern** — deterministic recovery systems spend a fixed retry budget only after the failed step leaves a mechanically proven candidate and bounded failure evidence. The bootstrap supervisor now makes the already-existing one-shot repair budget the normal path: a fresh repair worker receives the task packet, current candidate evidence, and exact failed checks, then verification reruns once. Failed second verification exhausts the budget and preserves the candidate rather than looping.
- **reject** — continuing the implementation conversation, repairing preflight/authority/no-change/finalization failures, or recursively launching workers. These states are either unsafe, unproven, or owned by separate recovery semantics.

### Unified lifecycle kernel decisions (issue #146)

- **adopt-pattern** — durable workflow kernels expose one typed single-work-item primitive and make entry points schedulers/adapters over it. Pi-next now promotes the bootstrap lifecycle mechanics into a production-owned `lifecycle` API with a canonical run/issue/phase projection consumed by bootstrap and available to explicit, auto, and monitor schedulers.
- **reject** — making `/pi-next auto` or bootstrap infer current truth from stale historical controller records, PLAN files, or worker UI. These remain evidence/projections; the lifecycle kernel result/projection is the current state contract.

### Bootstrap lifecycle lock decisions (issue #114)

- **adopt-pattern** — local process lock managers commonly use an atomic lock directory plus bounded owner metadata and heartbeat. The bootstrap utility adopts that filesystem primitive in `.git/pi-next/bootstrap-lifecycle/issue-N.lock`, keeping coordination outside candidate contents and failing closed for live or ambiguous owners.
- **reject** — timestamp-only stale stealing and Git-status-only producer inference. Recovery requires a valid issue/run/pid record and positive local evidence that the recorded process is dead; dirty candidate work is preserved for the normal finalizer/recovery path.

### Bootstrap supervisor decisions (issue #74)

- **adopt-pattern** — mini-SWE-agent's small `Agent`/`Environment`/`Model` separation and local environment process-group timeout pattern. The bootstrap utility keeps the same narrow seam: an injectable worker session factory, a canonical cwd, bounded cancellation, and no lifecycle authority in the worker. Its shell adapter kills the process group on timeout rather than importing the framework.
- **adopt-pattern** — SWE-bench's separation of candidate generation from mechanical grading. The utility treats Pi output as execution evidence, runs `npm run typecheck` and `npm test` itself, and never accepts worker completion prose as success.
- **adapter** — Pi's SDK `createAgentSession()` with `SessionManager.inMemory()` and a fresh session per implementation/repair/review attempt. This is the smallest plain-Pi adapter for the temporary developer tool; it does not load the pi-next extension or replace the parent host session.
- **reject** — queue progression, persistent chat management, lease/authority operations, automatic merge/push/close, and a second orchestration framework. The utility intentionally handles one explicit issue and leaves finalization to the existing trusted lifecycle/operator.

## Test layers

### 1. Protocol/model tests — no LLM

Create a simplified lifecycle model and execute generated command sequences against real kernel transitions.

Model dimensions should include work-item state, lease ownership, workspace state, candidate state, authority freshness, controller state, and pending verification.

Representative commands include discover, claim, prepare, startWorker, finishWorker, verify, promote, close, release, cleanup, crash, resume, authorityChanged, and leaseExpired.

Core invariants include:

- never two fresh owners for one work item;
- never mutate after known ownership loss;
- never close without current verified authority;
- never delete unique or unintegrated work;
- never promote an unverified candidate;
- never claim external verification as PASS;
- static preflight failures launch no expensive worker;
- re-running an already completed idempotent terminal step is harmless;
- a new-candidate claim race is candidate-local while active/resumed ownership loss fails closed;
- optimization budgets cannot prevent correctness-required lifecycle transitions.

Use model/property generation where practical. Preserve minimized failing sequences as permanent regressions.

#### Issue #79 lifecycle model-test decision

- **adopt** — `fast-check` is used directly for bounded lifecycle model tests. Its maintained model-based `commands` and `asyncModelRun` pattern supplies command preconditions, deterministic seeds, case budgets, and automatic shrinking to a minimal command sequence such as `claim(owner-a) -> expireLease() -> claim(owner-b) -> promoteAndClose()`. This avoids a pi-next-specific random generator/shrinker while keeping the reference model small and reviewable.
- **adopt-pattern** — the property test keeps the reference state deliberately smaller than production state: work item, lease, workspace, candidate, verification, and authority freshness. Commands drive production coordination primitives with memory authority, controllable clock, scripted workers, disposable Git, the bootstrap preflight/worker boundary, typed lifecycle checkpoint fault injection, guarded finalization, and reachability-fenced worktree cleanup; no LLM/provider credentials are involved. Normal CI uses a small deterministic budget, while `PI_NEXT_LIFECYCLE_MODEL_RUNS`, `PI_NEXT_LIFECYCLE_MODEL_MAX_COMMANDS`, and `PI_NEXT_LIFECYCLE_MODEL_SEED` allow larger local/nightly stress and fixed-seed reproduction.
- **reject** — custom shrinking or arbitrary source-code mutation. Fast-check already provides readable minimized command counterexamples, and permanent regressions should be promoted from those shrunk sequences when they expose a real bug.

### 2. Integration tests — real Git, no LLM

Use disposable temporary repositories and local bare remotes. Exercise real branches, canonical worktrees, commits, merges, pushes, reachability, cleanup, crash/restart, and migration boundaries without hosted remotes or deployment triggers. Workers remain scripted.

### 3. Historical incident replay — no LLM by default

Every meaningful real-world failure should be capturable as bounded structured evidence and replayable without private transcripts.

Replay fixtures may contain initial repository state, normalized authority state, scripted worker outcomes, lifecycle/fault events, and expected final invariants. The discoverable historical corpus/index lives in [`HISTORICAL_INCIDENT_REGRESSIONS.md`](HISTORICAL_INCIDENT_REGRESSIONS.md); new real lifecycle/controller/recovery fixes should add a sanitized fixture there or link an equivalent outer-path regression.

Permanent scenarios should include races, foreign/stale leases, non-zero worker exits, crash after claim/commit/push, crash after integration before cleanup, invalid consumer/provider preflight, authority changes before closure, PLAN narrowing live authority, pending external verification, unrelated main advancement, stale controller recovery, inherited cross-harness work, and scheduler continuation after candidate-local failure.

## Fault injection

Introduce named lifecycle checkpoints instead of timing-based sleeps. Initial checkpoints should cover candidate selection, lease claim, workspace preparation, authority load, plan readiness, worker start/finish, verification, candidate commit, promotion start/push, reachability proof, authority update, lease release, and workspace cleanup. The current typed checkpoint contract and coverage rule are documented in [`RECOVERY_LIFECYCLE_CHECKPOINTS.md`](RECOVERY_LIFECYCLE_CHECKPOINTS.md).

Test mode must be able to terminate at a checkpoint and restart from durable evidence. Recovery must be idempotent and must not repeat unsafe side effects merely because a process died between steps.

## Durable event journal

Move toward a bounded typed lifecycle journal containing facts needed for recovery and replay, for example:

```json
{"seq":1,"type":"work.selected","workItem":"640"}
{"seq":2,"type":"lease.claimed","owner":"run-17"}
{"seq":3,"type":"workspace.prepared"}
{"seq":4,"type":"worker.started","role":"implementation"}
{"seq":5,"type":"worker.completed"}
{"seq":6,"type":"verification.passed"}
{"seq":7,"type":"promotion.pushed","candidate":"abc123"}
```

The journal is recovery evidence, never authority. Resume always reconciles it against live authority and Git. Prompts, hidden reasoning, secrets, and unbounded command output do not belong in it.

## Agent evaluation — real worker, independent grader

Only after protocol/integration layers pass should a real coding worker be involved.

A fixture contains a known repository starting state plus an authoritative task specification. The worker produces a candidate and stops. A separate grader evaluates hidden tests/assertions and pi-next lifecycle assertions. Never grade success from the worker's own `completed` message.

Initial worker matrix:

- Pi: production/default baseline;
- mini-SWE-agent: first independent experimental adapter;
- Codex: later challenger if a small SDK adapter preserves the kernel contract;
- Claude: later challenger under the same condition.

The initial canary corpus lives in the worker-evaluation fixture format (`WORKER_CANARY_FIXTURE_FORMAT_VERSION = 1`) and currently covers localized bug fix, behavior change with tests, small multi-file refactor, repository inspection with targeted change, failure diagnosis/repair, and repository-contract adherence for generated files. Run it only when credentials/quota are explicitly available:

```sh
PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter pi
PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter pi --smoke
```

Primary metrics are verified acceptance pass rate, tokens/cost per verified completion, wall time per verified completion, retries/escalations, turn/command count, regressions introduced, context growth/cache efficiency, and pi-next intervention/recovery required.

The initial credentialed Pi baseline is recorded in [`evaluation/pi-worker-baseline.initial.json`](evaluation/pi-worker-baseline.initial.json). It is a sanitized grader-derived report for the full six-fixture corpus and includes adapter/model/harness identity, verified pass rate, wall time, token/cache/cost fields exposed by the Pi SDK, turns/tool calls, retries, and intervention status. Re-run it only with the explicit credential gate when intentionally refreshing the baseline.

## Release qualification

A candidate release should progress through:

```text
unit/type tests
  -> generated protocol/model tests
  -> historical incident replay
  -> real-Git integration/fault injection
  -> small real-worker canary set
  -> consumer compatibility smoke
  -> monitor-mode smoke (zero-token idle check, wake-on-work, graceful stop)
  -> release
```

Real-worker canaries should be small and bounded; protocol correctness should not depend on spending model tokens.

## Development policy

A non-trivial pi-next defect is not considered fully fixed until its real failure shape is represented by an automated regression at the highest practical layer. A newly discovered useful mechanism in another mature framework should be recorded in the reference feature harvest before pi-next independently reinvents it.

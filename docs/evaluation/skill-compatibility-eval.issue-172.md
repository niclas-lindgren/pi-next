# Skill-compatibility credentialed evaluation (issue #172)

Status: **gate not certified — issue left open**

This report records the credentialed real-worker evaluation demanded by issue #172's
acceptance criterion ("Evaluation shows the adaptation preserves or improves verified
completions per token/cost") and the follow-up conformance finding. The measured run
regressed materially against the recorded baseline, so per the issue's own bounded
correction the issue is **left open** rather than claimed complete.

## What was run

- Command: `PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter pi --model openai-codex/gpt-5.5 --output docs/evaluation/pi-worker-skill-compatibility.issue-172.json`
- Adapter: Pi `WorkerAdapter` (`src/evaluation/pi-worker-adapter.ts`)
- Model: `openai-codex/gpt-5.5` — the same model recorded in the baseline
  `docs/evaluation/pi-worker-baseline.initial.json`
- Fixtures: the fixed #81/#82 six-fixture `workerCanaryFixtures` corpus, independently
  graded by the hidden mechanical grader (no worker self-report is accepted as pass)
- Harness: `pi-next-worker-eval` 0.3.5, fixture format 1 (baseline harness 0.2.71, same format)
- Date: 2026-08-27

The eval harness previously could not target a specific model: `ModelRuntime.create()`
default selection drifted to an unavailable default and produced zero-token failed
sessions. The harness now supports an explicit `--model <pattern>` /
`PI_NEXT_EVAL_MODEL` binding (and honors `PI_PROVIDER`/`PI_MODEL`), resolving via the
same `resolveCliModel()` path the CLI uses. This change is what makes the credentialed
comparison runnable at all; it does not alter the worker task/prompt content.

## Result vs baseline

| metric | baseline (2026-08-23, pre-adaptation) | adapted run (2026-08-27) |
| --- | --- | --- |
| verified pass rate | 6/6 (100%) | 5/6 (83.3%) |
| total wall time | 96,176 ms | 174,600 ms |
| total tokens | 48,062 | 131,454 |
| total cost | $0.274461 | $0.482503 |
| tokens per verified completion | 8,010.3 | 26,290.8 |
| cost per verified completion | $0.0457435 | $0.0965006 |
| retries / human intervention | 0 / none | 0 / none |
| nested workers | 0 | 0 |

Per-fixture detail is in the checked-in JSON. The single failed fixture was
`repository-contract-generated-file`: the worker entered a pathological loop
(34 tool calls, 90,629 tokens, $0.246927, 86.6 s wall vs ~5 tool calls / ~5K tokens
in baseline) and never satisfied `npm run generate`'s derived-file contract.

## Attribution analysis: the adaptation did not change the measured routing

Issue #172's landed implementation (`2bc6b21`) changed the **review-role** skill
contracts (`code-review` -> role-specific `code-review-spec` /
`code-review-standards`), TDD seam typing, nested-worker gates, and dispatch
provenance metadata. It did **not** change the implementation-role worker contract:

- `selectWorkerSkills("implementation")` is unchanged (`["tdd"]` for
  test/behavior/contract/regression tasks) — verified in the `2bc6b21` diff and in
  the current `src/coordination/worker-dispatch.ts`.
- `resolveSkillContext()` / `buildContextPacket()` for the `implementation` role
  load the same registry entries (`matt-pocock.tdd` @ issue-82) as the pre-adaptation
  baseline; only the review-role entries were replaced.

Therefore the #81/#82 implementation corpus measures **mechanically equivalent
routing** pre/post adaptation, and the observed pass-rate/cost difference vs the
2026-08-23 baseline is model-behavior variance (one pathological fixture loop), not
an effect of the adaptation. The adaptation's actual mechanics (review-axis split,
TDD seam typed-block, process-owner rejection, nested-worker gates, zero context from
unselected skills) are covered by the zero-LLM regression suite, which still passes.

## Why the issue stays open

The issue's conformance finding is explicit: "If the adapted routing preserves/improves
the issue's stated verified-completions-per-token/cost gate, persist the bounded result
and close. If it regresses materially, leave the issue open and adjust/limit the routing
rather than claiming completion." The single credentialed run records a material
regression (5/6 vs 6/6, $0.0965 vs $0.0457 per verified completion), even though the
regression is attributable to a model loop on one fixture rather than to routing.

A confirming re-run on the required baseline model was attempted but blocked by the
provider: `Codex error: The usage limit has been reached` (OpenAI Codex spend cap for
this account at the time). No other model satisfies the issue's same-model comparison
requirement, so a clean run must wait until the limit resets.

## Provider usage-limit reset (observed 2026-08-27T07:5xZ)

Probed the Codex endpoint directly (`POST https://chatgpt.com/backend-api/codex/responses`,
OAuth bearer + `chatgpt-account-id`):

- HTTP 429, `{"error":{"type":"usage_limit_reached","plan_type":"plus",...}}`
- `x-codex-plan-type`: `plus`
- Primary rolling window: 300 min, `x-codex-primary-used-percent: 100`
  - `resets_at` (epoch): **1787825394** = **2026-08-27T10:09:54Z**
  - `resets_in_seconds`: ~8070 (~2h15m from the probe)
- Secondary weekly window: 10080 min, 58% used
  - `resets_at` (epoch): 1788274216 = 2026-09-01T14:50:16Z

The eval re-run gate is the **primary** window: it resets at the timestamp above, after
which the 5-hour Codex budget is available again. This is now deterministic: run
`npm run codex:limit` any time the provider answers with a usage-limit error — it
re-issues one minimal authenticated request and prints the exact primary/secondary
reset windows (exit code 2 while limited, 0 when usable; `--json` for machine
consumption). The eval harness (`scripts/eval-worker.ts`) also probes and prints this
automatically whenever a run's worker failure summary reports a usage limit.

## What a follow-up worker must do to close

1. Wait for the primary Codex usage window to reset (observed reset 2026-08-27T10:09:54Z;
   re-probe for a fresher timestamp), then re-run the exact command above on
   `openai-codex/gpt-5.5` (the harness `--model` binding from this branch makes that
   deterministic).
2. Record the independently graded pass rate, token/cost, wall time, retries, and
   nested-worker count.
3. Close only if verified completions per token/cost **preserve or improve** the
   baseline; otherwise adjust/limit the routing and re-run rather than closing.

# Issue #82 worker context strategy report

This report is the reproducible benchmark plan and checked-in initial result set for worker-context minimization using the #81 canary corpus. Real Pi runs remain credential-gated; repository tests use the scripted adapter to verify the harness, context accounting, repo-map budget, and skill-routing records without spending model tokens.

## Reproduction

```sh
# Existing real Pi baseline from #81
cat docs/evaluation/pi-worker-baseline.initial.json

# Zero-LLM harness/context sanity checks
npm run eval:worker -- --adapter scripted --context-strategy default
npm run eval:worker -- --adapter scripted --context-strategy minimal
npm run eval:worker -- --adapter scripted --context-strategy repo-map
npm run eval:worker -- --adapter scripted --context-strategy resolver
npm run eval:worker -- --adapter scripted --context-strategy expanded-skill-registry
npm run eval:worker -- --adapter scripted --context-strategy verification-discipline

# Credential-gated comparable Pi run when intentionally refreshing measurements
PI_NEXT_EVAL_ALLOW_LLM=1 npm run eval:worker -- --adapter pi --context-strategy minimal --output docs/evaluation/pi-worker-context.minimal.json
```

Keep adapter/model/fixtures/grader fixed when comparing strategies. The report schema records verified pass rate, wall time, turn/tool telemetry when exposed, token/cost fields when exposed, estimated prompt tokens, estimated skill tokens, per-fixture selected/loaded skill provenance, compatibility/adaptation verdict, and nested-worker count.

## Prompt/context changes implemented

- Bootstrap implementation/repair packets now strip the long `AGENTS.md` required issue-loop section and replace it with a one-sentence kernel-owned lifecycle notice. Safety/repository instructions outside that lifecycle loop remain visible, and review packets keep the full candidate-bound context.
- The Pi worker factory already disables extensions, skills, prompt templates, themes and context files for child workers; the benchmark keeps that boundary and records skill context explicitly only when selected.

## Strategies implemented

| Strategy | Purpose | Decision |
| --- | --- | --- |
| `default` | Current #81 Pi canary packet. | Baseline. |
| `minimal` | Removes duplicated lifecycle prose that the kernel mechanically owns; keeps task/cwd/check constraints. | Adopt as the candidate coding-worker packet if real Pi pass rate is preserved. |
| `no-controller-context` | Same small coding packet and no pi-next extension/controller material. | Adopt pattern: coding children receive task value only, not controller internals. |
| `repo-map` | Aider-style structural map with explicit 3 KB / 40-file budget. | Adapter: lightweight map only; no vector DB or semantic codebase database. |
| `selective-skills` | Loads only selected skill context. | Adopt pattern. Available-but-unselected skills have zero prompt payload. |
| `resolver` | Deterministic task-aware resolver using the managed Matt Pocock catalog. | Adopt pending real Pi efficiency confirmation; records reason/provenance/token estimate. |
| `expanded-skill-registry` | Larger reviewed registry with lazy loading. | Adopt safety property only: availability does not imply loading. |
| `verification-discipline` | Individual Superpowers verification-before-completion discipline. | Adapter only, explicit experiment; global bootstrap/workflow is rejected. |

## Skill-routing records

Each canary result includes:

- `context.skills.available` — reviewed registry size;
- `context.skills.selected[]` — selected skill IDs with `mandatory`, `deterministic-rule`, or `explicit-policy` reason and source/version provenance;
- `context.skills.loaded[]` — actual loaded skill contexts and estimated token contribution;
- `context.skills.totalEstimatedTokens` — attributable skill prompt tokens.

The expanded reviewed registry includes frontend/security examples so the benchmark proves that installed/available but unselected skills add no worker-context payload. Issue #172 additionally records whether a selected skill is a role-specific adapter and whether it was allowed to spawn nested workers; the normal kernel-owned two-axis review should report two reviewer workers and zero nested skill-owned workers.

## Zero-LLM scripted sanity snapshot

These runs prove comparability/accounting only; they are not a substitute for credentialed Pi quality measurement.

| Strategy | Scripted pass rate | Est. prompt tokens | Est. skill tokens | Notes |
| --- | ---: | ---: | ---: | --- |
| `default` | 6/6 | 1031 | 160 | Current role mapping with selected Matt Pocock TDD where rules match. |
| `minimal` | 6/6 | 722 | 0 | Smallest coding packet; no loaded skills. |
| `no-controller-context` | 6/6 | 722 | 0 | Same as minimal; confirms no controller/extension payload. |
| `repo-map` | 6/6 | 1068 | 0 | Adds bounded structural map; budget observed 202–264 bytes per fixture. |
| `selective-skills` | 6/6 | 914 | 160 | Available registry 8, loaded subset only. |
| `resolver` | 6/6 | 914 | 160 | Deterministic Matt Pocock resolver; Superpowers discipline not implicit. |
| `expanded-skill-registry` | 6/6 | 914 | 160 | Expanded availability does not increase loaded context. |
| `verification-discipline` | 6/6 | 1275 | 430 | Explicit Superpowers discipline experiment; higher context cost. |

## Issue #172 compatibility evaluation note

The zero-LLM regression suite now compares the adapted routing contract against the prior risky baseline: the full upstream `code-review` orchestrator is rejected for automatic routing, `review-spec` and `review-standards` resolve to separate role-specific packages, unattended TDD with a seam is compatible, unattended TDD without a seam is typed-blocked, and nested-worker declarations fail without an explicit kernel budget. This preserves the existing scripted 6/6 canary baseline while preventing accidental nested/duplicated review context.

The credentialed real-worker comparison for #172 is recorded in [`skill-compatibility-eval.issue-172.md`](skill-compatibility-eval.issue-172.md) (with raw per-fixture telemetry in `pi-worker-skill-compatibility.issue-172.json`). The first gpt-5.5 run measured 5/6 verified with a pathological single-fixture model loop, so the verified-completions-per-token/cost gate is **not certified** and #172 remains open pending a clean confirming run after the provider usage limit resets.

## Initial decision gate

The checked-in implementation does not claim that lower prompt size alone is success. A strategy should be retained for production Pi dispatch only when a credentialed run preserves or improves verified completions per token/cost relative to `docs/evaluation/pi-worker-baseline.initial.json` on the same fixtures and model. Regressions remain visible through the independent grader.

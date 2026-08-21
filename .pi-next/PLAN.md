# Plan: Issue #48

**Goal:** Ensure workflow-only/lifecycle commit budgeting never blocks correctness-required authority reconciliation or terminal durability, while preserving a bounded ordinary churn limit.

**GitHub-Issue:** #48

## Tasks
- [x] Add a mechanically bounded correctness-required transition policy to workflow commit telemetry and admission checks.
  - Files: extensions/pi-next/workflow-commit-policy.ts, extensions/pi-next/commit-safety.ts
  - Approach: require explicit, validated necessity metadata; allow at most one reserved transition per unchanged authority/fingerprint and record the reason.
- [x] Thread correctness metadata through authority reconciliation/final archive paths without allowing arbitrary workflow commits to bypass the ordinary budget.
  - Files: extensions/pi-next/tools-update.ts, extensions/pi-next/tools-git.ts, extensions/pi-next/tools-check.ts
  - Approach: mark only mechanically known final/authority/recovery transitions as eligible and retain explicit-path and safety checks.
- [x] Add controller/integration regression tests for exhausted budgets, required reconciliation, terminal transitions, duplicate prevention, and ordinary churn refusal.
  - Files: test/workflow-commit-policy.test.ts and relevant integration coverage
  - Approach: use isolated temporary repositories and exercise real commit/tool boundaries.

## Acceptance Criteria
- [ ] Required authority reconciliation remains possible after the ordinary workflow budget is exhausted.
- [ ] Correctness escape is bounded, explicit, path-restricted, and cannot repeat for the same unchanged authority/fingerprint.
- [ ] Ordinary workflow-only churn remains subject to the existing limit.
- [ ] Semantic, lease, worktree, candidate, hook, and explicit-path safety remain fail-closed.
- [ ] Telemetry distinguishes ordinary budget use from exceptional correctness transitions.
- [ ] Required typecheck and tests pass.

## Log
- 2026-08-21: Selected next live open issue #48 after completing #45; claimed lease and prepared `.worktrees/issue-48`.
- 2026-08-21: Added evidence-bound authority reconciliation admission, bounded per-fingerprint correctness escapes for terminal/cleanup transitions, and regression coverage; full typecheck/test suite passes.

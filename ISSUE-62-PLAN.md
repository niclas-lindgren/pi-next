# Issue #62 plan

## Authority snapshot

- Issue: #62, `fix(convergence): do not apply new token budgets retroactively to pre-budget run metrics`
- Snapshot: 2026-08-21, open; assignee `niclas-lindgren`; no comments.
- Scope: convergence budget activation/accounting, scheduler-step accounting, status diagnostics, and compatibility tests.

## Implementation slices

- Inspect durable loop-state and budget decision semantics; add explicit policy epoch/baselines with deterministic migration for existing metrics.
- Use a fairness-appropriate token metric/defaults and prevent zero-worker preflight yields from consuming worker/model steps where the controller can avoid it.
- Expose bounded budget basis/trigger diagnostics while preserving non-destructive run-local yields.
- Add regression tests for historical metrics, restart/policy migration, genuine exhaustion, step accounting, and status output; update release documentation.

## Verification

- `npm run typecheck`
- `npm test`
- Focused convergence/loop-state/status tests.

## Completion evidence

- Re-query issue authority immediately before commit/finalization and again after push before closure.

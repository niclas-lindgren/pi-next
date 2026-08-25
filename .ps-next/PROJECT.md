# pi-next
An experimental autonomous work-item lifecycle kernel, packaged as an extension for the pi-coding-agent host, that provides authority/leasing, recovery, verification, and guarded completion for autonomous issue implementation loops.

## Stack
- Language/runtime: TypeScript, Node.js (>=22.19.0)
- Framework: pi-coding-agent extension (`extensions/pi-next.ts` entry point); shared lifecycle kernel in `src/lifecycle/`, coordination primitives in `src/coordination/`
- Database: none (durable state persisted as local files/journal, e.g. loop state and diagnostics under `.pi-next/`)

## Conventions
- Package-owned, product-neutral defaults; consumers select explicit versioned adapter/provider overrides rather than relying on file-presence-based implicit overrides.
- `src/lifecycle/kernel.ts` owns claim/authority/candidate/verification/finalization semantics — extension-level code (`extensions/pi-next/*.ts`) must not duplicate or bypass that logic.
- Deterministic, zero-LLM regression tests are required for new lifecycle/status behavior (scripted workers, fake authority, disposable git, deterministic clocks).
- Legacy persisted state must be migrated mechanically or rejected explicitly with actionable guidance — never silently misinterpreted.

## Build & test
- Build: `npm run build` (`tsc --noEmit`)
- Test: `npm test` (`node scripts/check-file-size.mjs && node scripts/run-tests-safe-git.mjs --all`)

## Meta
- No CLAUDE.md present in this repo; primary agent-facing doc is `AGENTS.md` at the repo root.

## Codebase Notes
- `extensions/pi-next.ts` is the pi-coding-agent extension entry point; the bulk of loop/status/supervision logic lives under `extensions/pi-next/*.ts` (e.g. `loop.ts`, `loop-state.ts`, `loop-status.ts`, `loop-controller.ts`, `foreground-supervisor.ts`, `production-lifecycle.ts`, `auto-progress.ts`).
- `src/lifecycle/` holds the shared, kernel-owned lifecycle scheduler (`scheduler.ts`, `kernel.ts`) that the extension layer is being converged onto (see `.ps-next/PLAN.md`).
- `src/coordination/` holds work-authority, worker-dispatch, adversarial-review, feedback, and self-assessment primitives, each with its own package export.
- `test/` contains deterministic test suites (e.g. `production-lifecycle.test.ts`, `loop-status.test.ts`, `auto-status.test.ts`, `lifecycle-scenarios.test.ts`, `worker-failure.test.ts`) run via `scripts/run-tests-safe-git.mjs`.
- An active migration (`.ps-next/PLAN.md`) is converging `/pi-next auto` status/footer and `/pi-next-loop` stop/cancel/resume onto the shared lifecycle scheduler via a durable AbortSignal-based cancellation contract, retiring the legacy `ForegroundSupervisor`/`loop-controller.ts` state machine.

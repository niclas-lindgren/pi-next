# Backlog

## Open

- [1] [ ] Lifecycle status/footer projection convergence — Make /pi-next auto's status and footer a faithful typed projection of the shared lifecycle scheduler's disposition (idle/completed/budget-yield/blocked) instead of collapsing states into "stopped".
- [2] [ ] Durable stop/cancel contract — Route /pi-next-loop stop through an AbortSignal-based cancellation contract wired into runProductionLifecycleScheduler, so stop reliably reaches a running fresh scheduler run.
- [3] [ ] Scheduler-routed resume — Make /pi-next-loop resume call the shared scheduler for unified-scheduler-produced state, and reject legacy pre-migration state explicitly with actionable migration guidance.
- [4] [ ] Legacy state machine retirement — Delete ForegroundSupervisor and loop-controller.ts once no supported stop/cancel/resume path depends on them, and re-audit dependent tests individually.
- [5] [ ] Deterministic lifecycle regression suite — Add zero-LLM regression tests covering terminal-state reporting, stop/cancel boundaries, and legacy-state rejection using the scripted-worker/fake-authority/disposable-git pattern.
- [6] [ ] Adapter contract hardening — Extend the versioned adapter/provider override system so consumer repos can safely customize worker harness behavior without forking kernel defaults.
- [7] [ ] Operator-facing documentation and release notes — Document the new lifecycle status vocabulary, stop/resume contract, and migration guidance for consumers upgrading from the legacy loop model.

## Done

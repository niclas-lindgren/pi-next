# Recovery lifecycle checkpoints

Pi-next exposes a bounded, typed set of recovery-relevant lifecycle checkpoints in `src/coordination/lifecycle-checkpoints.ts`.

These checkpoints are intentionally coarse. They mark externally meaningful idempotency boundaries where a crash/restart must reconcile durable journal facts with live authority, leases, Git, worker evidence, verification, completion, or cleanup. They are not tracing hooks for every helper function.

Fault injection is disabled in production by default. Tests may opt in with `withLifecycleFaultInjection(...)`, or a dev/test subprocess may set both:

```sh
PI_NEXT_ENABLE_LIFECYCLE_FAULT_INJECTION=1
PI_NEXT_LIFECYCLE_FAULT_AT=checkpoint:before:throw
```

The position is `before` or `after`; the action is `throw`, `cancel`, or explicitly opt-in `exit`. Injected failures include the checkpoint and position in the error message.

## Coverage rule

Every checkpoint must be listed in `RECOVERY_LIFECYCLE_CHECKPOINTS` and documented in `RECOVERY_LIFECYCLE_CHECKPOINT_COVERAGE`. New recovery-sensitive transitions must update that typed coverage and the crash/restart matrix in `test/lifecycle-checkpoints.test.ts`.

The current checkpoints cover selection, lease ownership, workspace preparation, authority load/reconciliation, planning, worker dispatch/settlement, verification, local candidate commit, candidate branch push, promotion start, remote main push, promotion success recording, reachability proof, pending verification, closure, lease release, and cleanup. Candidate commit and branch push are deliberately separate so crash/restart tests exercise the real Git mutation boundary rather than only journal append helpers.

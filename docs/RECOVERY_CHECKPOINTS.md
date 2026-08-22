# Recovery lifecycle checkpoints

Pi-next exposes a small typed set of recovery/idempotency checkpoints in
`src/coordination/lifecycle-checkpoints.ts`. They are externally meaningful
boundaries, not internal function-call probes:

- `candidate_selected`
- `lease_claimed`
- `workspace_prepared`
- `authority_loaded`
- `plan_ready`
- `worker_started`
- `worker_finished`
- `verification_finished`
- `candidate_committed`
- `promotion_started`
- `promotion_succeeded`
- `reachability_proven`
- `authority_reconciled`
- `pending_verification_recorded`
- `issue_closed`
- `lease_released`
- `workspace_cleaned`

Production execution has no active fault behavior by default. Tests and
dev-only repros may use `withLifecycleFaultInjection({ checkpoint, position })`
or the guarded environment form:

```sh
PI_NEXT_ENABLE_LIFECYCLE_FAULT_INJECTION=1 \
PI_NEXT_LIFECYCLE_FAULT_AT=promotion_succeeded:after:throw \
  <command>
```

Positions are `before` and `after`. Failure output includes the checkpoint name
and position. `throw` is the default action; `exit` exists only for explicit
subprocess crash tests.

New recovery-sensitive transitions must either be added to the typed checkpoint
list and crash/restart matrix, or be classified in tests as non-boundary journal
facts. Checkpoints should remain bounded around authority, lease, worker,
verification, promotion, reachability, completion, release, and cleanup
transitions.

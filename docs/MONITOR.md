# Pi-next monitor mode

Monitor mode keeps the parent Pi host open and mechanically checks the configured authority for currently eligible work. Idle polling does not call a model and does not keep a worker conversation alive.

Commands:

```text
/pi-next monitor start
/pi-next monitor status
/pi-next monitor stop
```

When the selector reports eligible work, monitor mode wakes the existing `/pi-next auto` scheduler path. Claiming, lease CAS, canonical worktree preparation, child `WorkerAdapter` dispatch, verification, finalization, and cleanup remain owned by the normal scheduler. Authority observations are only wake hints; they are never ownership proof. The monitor runtime requires an explicit scheduler callback at construction time so an eligible wake-up cannot silently become a no-op or a monitor-local lifecycle implementation.

`stop` is graceful: future polling is cancelled immediately, and any active scheduler/worker is allowed to finish its normal safe boundary.

Optional configuration in `.pi-next/config.json`:

```json
{
  "monitor": {
    "pollIntervalMs": 60000,
    "maxBackoffMs": 600000
  }
}
```

Status reports bounded operational state: monitoring/working/backoff/stopped, last successful check, next check, selection summary, active wake/run, last typed error, and wake/launch counters. It must not contain prompts, transcripts, secrets, or issue bodies.

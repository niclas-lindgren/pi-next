/**
 * In-memory, in-process AbortController registry for fresh unified-scheduler
 * runs (issue #165).
 *
 * The persisted `LoopState.stopRequested` flag remains the durable,
 * cross-process stop signal (another process, or a resumed session, can
 * always observe it). This registry exists purely so `/pi-next-loop stop`
 * can additionally reach a scheduler run that is live *in this process* and
 * abort it immediately via the AbortSignal contract already threaded through
 * `runProductionLifecycleScheduler` -> `runLifecycleScheduler`, instead of
 * only writing a flag the scheduler polls at its next boundary.
 *
 * Keyed by runId, not by cwd/session: a runId is already the durable unique
 * identity for a scheduler execution, and multiple runs (different cwds, or
 * historical/resumed runs) may be registered at once.
 */
const controllers = new Map<string, AbortController>();

/**
 * Register the AbortController backing a fresh scheduler run. Returns an
 * unregister function the caller must invoke once the run settles (success,
 * failure, or abort) so the registry never outlives the run it tracks.
 */
export function registerRunAbortController(
  runId: string,
  controller: AbortController,
): () => void {
  controllers.set(runId, controller);
  return () => {
    // Only clear the entry if it still belongs to this exact controller: a
    // later run reusing the same runId (should not happen, but is not worth
    // trusting) must never have its live controller clobbered by a stale
    // unregister from an earlier run.
    if (controllers.get(runId) === controller) controllers.delete(runId);
  };
}

export function getRunAbortController(runId: string): AbortController | undefined {
  return controllers.get(runId);
}

/**
 * Abort the in-process controller for `runId`, if one is registered here.
 * Returns whether an in-process controller was found and aborted; `false`
 * means the caller must rely on the durable `stopRequested` file flag alone
 * (e.g. the run lives in a different process, or predates this registry).
 */
export function abortRun(runId: string, reason?: string): boolean {
  const controller = controllers.get(runId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort(reason);
  return true;
}

/** Test-only reset so unrelated specs never observe a leaked singleton. */
export function __resetRunCancellationForTests(): void {
  controllers.clear();
}

import type {
  WorkerAdapter,
  WorkerEventSink,
  WorkerTask,
} from "../../src/coordination/worker-adapter.ts";
import { WORKER_ADAPTER_VERSION } from "../../src/coordination/worker-adapter.ts";
import {
  runIssueWorker,
  type IssueWorkerOptions,
  type IssueWorkerResult,
  type IssueWorkerRunner,
} from "./util-core.ts";

/** Pi-specific execution options stay below the harness-neutral adapter seam. */
export interface PiWorkerTask extends WorkerTask {
  options?: IssueWorkerOptions;
}

export type PiWorkerCompatibleAdapter = WorkerAdapter<
  PiWorkerTask,
  IssueWorkerResult
>;

function emitSafely(emit: WorkerEventSink | undefined, event: Parameters<WorkerEventSink>[0]): void {
  try {
    emit?.(event);
  } catch {
    // Live observations are diagnostic only and can never change worker truth.
  }
}

/**
 * Current/default Pi harness adapter.
 *
 * `runIssueWorker` remains the proven low-level child-process primitive. This
 * adapter owns translation between the kernel task contract and Pi's process
 * options while deliberately receiving no lease, authority, promotion,
 * closure, verification or cleanup capabilities.
 */
export class PiWorkerAdapter implements PiWorkerCompatibleAdapter {
  readonly id = "pi";
  readonly version = WORKER_ADAPTER_VERSION;

  constructor(private readonly runner: IssueWorkerRunner = runIssueWorker) {}

  run(
    task: PiWorkerTask,
    signal: AbortSignal,
    emit?: WorkerEventSink,
  ): Promise<IssueWorkerResult> {
    const options = task.options ?? {};
    if (options.dispatch && task.dispatch && options.dispatch !== task.dispatch) {
      throw new Error("PiWorkerAdapter received conflicting worker dispatch bindings");
    }
    if (options.issueNumber !== undefined && task.issueNumber !== undefined && options.issueNumber !== task.issueNumber) {
      throw new Error("PiWorkerAdapter received conflicting issue bindings");
    }
    if (options.runId && task.runId && options.runId !== task.runId) {
      throw new Error("PiWorkerAdapter received conflicting run bindings");
    }
    if (options.phase && task.phase && options.phase !== task.phase) {
      throw new Error("PiWorkerAdapter received conflicting phase bindings");
    }
    if (options.coordinationCwd && task.coordinationCwd && options.coordinationCwd !== task.coordinationCwd) {
      throw new Error("PiWorkerAdapter received conflicting coordination roots");
    }

    return this.runner(task.cwd, task.prompt, {
      ...options,
      signal,
      issueNumber: task.issueNumber ?? options.issueNumber,
      runId: task.runId ?? options.runId,
      phase: task.phase ?? options.phase,
      dispatch: task.dispatch ?? options.dispatch,
      coordinationCwd: task.coordinationCwd ?? options.coordinationCwd,
      readOnly: task.readOnly ?? options.readOnly,
      onActivity: (event) => {
        options.onActivity?.(event);
        emitSafely(emit, {
          type: "activity",
          phase: event.phase,
          kind: event.kind,
          summary: event.summary,
          ...(event.relatedPaths?.length ? { relatedPaths: event.relatedPaths } : {}),
        });
      },
      onWorkerState: (runtime) => {
        options.onWorkerState?.(runtime);
        emitSafely(emit, { type: "runtime", ...runtime });
      },
      onWatchdog: (event) => {
        options.onWatchdog?.(event);
        emitSafely(emit, {
          type: "watchdog",
          kind: event.kind,
          wallClockMs: event.wallClockMs,
          idleMs: event.idleMs,
          reason: event.reason,
        });
      },
    });
  }
}

/**
 * Compatibility bridge for the existing controller's promise-based worker
 * runner. It is intentionally tiny so the controller can migrate to the
 * explicit adapter seam without changing lifecycle semantics in the same
 * refactor.
 */
export function issueWorkerRunnerFromAdapter(
  adapter: PiWorkerCompatibleAdapter,
): IssueWorkerRunner {
  return (cwd, prompt, options = {}) => {
    const fallbackController = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? fallbackController!.signal;
    return adapter.run(
      {
        cwd,
        prompt,
        issueNumber: options.issueNumber,
        runId: options.runId,
        phase: options.phase,
        dispatch: options.dispatch,
        coordinationCwd: options.coordinationCwd,
        readOnly: options.readOnly,
        options,
      },
      signal,
    );
  };
}

import type {
  WorkerAdapter,
  WorkerEventSink,
  WorkerTask,
  WorkerTerminalFailure,
  WorkerTerminalResult,
  WorkerUsageTelemetry,
} from "../coordination/worker-adapter.js";
import { WORKER_ADAPTER_VERSION } from "../coordination/worker-adapter.js";
import { BootstrapProgressEvent, DEFAULT_TIMEOUT_MS, WorkerFactory, WorkerReport, WorkerRole } from "./types.js";
import { runWorker } from "./worker-runner.js";
import { createDefaultWorkerFactory } from "./worker-factory.js";

export interface SdkSessionWorkerTask extends WorkerTask {
  role?: WorkerRole;
  timeoutMs?: number;
}

function usageFromReport(report: WorkerReport): WorkerUsageTelemetry | undefined {
  if (!report.usage) return undefined;
  return {
    input: report.usage.input,
    output: report.usage.output,
    cacheRead: report.usage.cacheRead,
    cacheWrite: report.usage.cacheWrite,
    totalTokens: report.usage.total,
    cost: report.usage.cost,
  };
}

function failureFromReport(report: WorkerReport): WorkerTerminalFailure | undefined {
  if (report.disposition === "completed") return undefined;
  const reason = report.reason ?? `worker ${report.disposition}`;
  const typedCode = /^([A-Z][A-Z_]+): /.exec(reason)?.[1];
  const code = typedCode
    ?? (report.disposition === "timed_out" ? "WORKER_TIMEOUT" : report.disposition === "cancelled" ? "WORKER_CANCELLED" : "WORKER_EXECUTION_FAILED");
  return { code, summary: reason, diagnosticExcerpt: reason };
}

function bridgeReporter(emit: WorkerEventSink, phase: string | undefined): (event: BootstrapProgressEvent) => void {
  return (event) => {
    if (event.phase !== "worker" || event.state !== "activity") return;
    try {
      emit({ type: "activity", phase, kind: event.tool ?? "activity", summary: event.tool ? `tool ${event.tool} executed` : "worker activity" });
    } catch {
      // Live observations are diagnostic only and can never change worker truth.
    }
  };
}

/**
 * Harness-neutral WorkerAdapter (#75/#146) over bootstrap's in-process Pi SDK
 * session worker (`runWorker`), including the evidence-based terminal-result
 * classification proven by #151 instead of inferring success from a resolved
 * `session.prompt()` promise. This wraps rather than reimplements `runWorker`
 * so its classification and tests stay the single source of truth; it is the
 * first concrete convergence step toward the unified kernel described in #146.
 */
export class SdkSessionWorkerAdapter implements WorkerAdapter<SdkSessionWorkerTask, WorkerTerminalResult> {
  readonly id = "pi-sdk-session";
  readonly version = WORKER_ADAPTER_VERSION;

  constructor(private readonly factory: WorkerFactory) {}

  async run(task: SdkSessionWorkerTask, signal: AbortSignal, emit?: WorkerEventSink): Promise<WorkerTerminalResult> {
    const reports: WorkerReport[] = [];
    const reporter = emit ? bridgeReporter(emit, task.phase) : undefined;
    const report = await runWorker(
      this.factory,
      task.role ?? "implementation",
      task.prompt,
      task.cwd,
      task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reports,
      task.issueNumber ?? 0,
      reporter,
      0,
      signal,
    );
    return {
      ok: report.disposition === "completed",
      output: "",
      code: report.disposition === "completed" ? 0 : null,
      signal: null,
      telemetry: {
        status: report.terminalResultObserved ? (report.disposition === "completed" ? "complete" : "partial") : "unavailable",
        usage: usageFromReport(report),
        activity: { modelRounds: report.terminalResultObserved ? 1 : 0, toolCalls: report.toolCalls, toolResults: report.toolCalls },
        model: report.model,
      },
      failure: failureFromReport(report),
    };
  }
}

/** Default adapter over the real Pi SDK session factory, mirroring createDefaultWorkerFactory's laziness. */
export async function createDefaultSdkSessionWorkerAdapter(): Promise<SdkSessionWorkerAdapter> {
  return new SdkSessionWorkerAdapter(await createDefaultWorkerFactory());
}

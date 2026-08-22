import type { WorkerDispatchPolicy } from "./worker-dispatch.ts";

/**
 * Version of the harness-neutral worker execution contract.
 *
 * This version is intentionally independent of WorkerDispatchPolicy.version:
 * dispatch describes what a worker may do, while this contract describes how
 * the lifecycle kernel invokes a worker harness and observes its bounded
 * result/events.
 */
export const WORKER_ADAPTER_VERSION = "1" as const;

/** Exact controller-selected task handed to a worker harness. */
export interface WorkerTask {
  cwd: string;
  prompt: string;
  issueNumber?: number;
  runId?: string;
  phase?: string;
  dispatch?: WorkerDispatchPolicy;
  coordinationCwd?: string;
  readOnly?: boolean;
}

export interface WorkerActivityEvent {
  type: "activity";
  phase?: string;
  kind: string;
  summary: string;
  relatedPaths?: string[];
}

export interface WorkerRuntimeEvent {
  type: "runtime";
  pid?: number;
  startedAt: string;
  lastActivityAt: string;
  lastActivityKind?: string;
  alive: boolean;
}

export interface WorkerWatchdogAdapterEvent {
  type: "watchdog";
  kind: "suspected_stall" | "worker_timeout";
  wallClockMs: number;
  idleMs: number;
  reason: string;
}

/**
 * Small event vocabulary visible to the lifecycle kernel. Harness-specific raw
 * streams, prompts, reasoning and tool payloads do not cross this boundary.
 */
export type WorkerEvent =
  | WorkerActivityEvent
  | WorkerRuntimeEvent
  | WorkerWatchdogAdapterEvent;

export type WorkerEventSink = (event: WorkerEvent) => void;

export interface WorkerUsageTelemetry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface WorkerTerminalTelemetry {
  status: "complete" | "partial" | "unavailable";
  usage?: WorkerUsageTelemetry;
  activity?: {
    modelRounds: number;
    toolCalls: number;
    toolResults: number;
  };
  model?: string;
}

export interface WorkerTerminalFailure {
  code: string;
  summary: string;
  diagnosticExcerpt: string;
}

/** Bounded terminal result owned by the harness, not by lifecycle authority. */
export interface WorkerTerminalResult {
  ok: boolean;
  output: string;
  code: number | null;
  signal: string | null;
  telemetry: WorkerTerminalTelemetry;
  failure?: WorkerTerminalFailure;
}

/**
 * Harness-neutral worker seam.
 *
 * The design document shows an AsyncIterable as the conceptual shape. The
 * current lifecycle already has a stable promise + bounded callback stream, so
 * v1 keeps that proven mechanism: `emit` carries typed live events and the
 * promise carries exactly one terminal result. A future adapter can internally
 * use an async iterator without changing kernel authority ownership.
 *
 * Implementations MUST NOT own leases, work authority, promotion, issue
 * closure, verification truth, or workspace cleanup. Those remain lifecycle
 * kernel responsibilities.
 */
export interface WorkerAdapter<
  TTask extends WorkerTask = WorkerTask,
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
> {
  readonly id: string;
  readonly version: string;
  run(
    task: TTask,
    signal: AbortSignal,
    emit?: WorkerEventSink,
  ): Promise<TResult>;
}

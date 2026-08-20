import type { LoopUsage } from "./loop-state.ts";
import type { WorkerDispatchPolicy } from "../../src/coordination/worker-dispatch.ts";

/** Aggregate model-round/tool-call activity for one issue-worker invocation. */
export interface WorkerActivity {
  modelRounds: number;
  toolCalls: number;
  toolResults: number;
}

/**
 * Whether {@link WorkerTelemetryReport} reflects a genuinely completed turn.
 * `unavailable` means no usable telemetry could be recovered at all (e.g. the
 * child crashed before emitting any JSON events); `partial` means the child
 * started but did not reach a clean `agent_end` (aborted/killed mid-turn), so
 * whatever usage/activity fields are present are real but may be incomplete.
 * Callers must never collapse `unavailable`/`partial` into numeric zero.
 */
export type WorkerTelemetryStatus = "complete" | "partial" | "unavailable";

export interface WorkerTelemetryReport {
  status: WorkerTelemetryStatus;
  usage?: LoopUsage;
  activity?: WorkerActivity;
  model?: string;
  /** Controller-selected metadata, never prompt text or transcript content. */
  dispatch?: Pick<WorkerDispatchPolicy, "version" | "role" | "skills" | "capabilityProfile">;
}

const ZERO_USAGE: LoopUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Mirrors loop-state.ts's sessionUsage() per-message summation, applied to
 * one child-reported assistant message instead of a live ctx.sessionManager
 * entry, so both paths derive usage the same way. */
function addMessageUsage(usage: LoopUsage, message: Record<string, unknown>): void {
  const raw = message.usage;
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  usage.input += finite(value.input);
  usage.output += finite(value.output);
  usage.cacheRead += finite(value.cacheRead);
  usage.cacheWrite += finite(value.cacheWrite);
  usage.totalTokens += finite(value.totalTokens);
  const cost = value.cost;
  if (cost && typeof cost === "object") {
    usage.cost += finite((cost as Record<string, unknown>).total);
  }
}

function modelFromMessage(message: Record<string, unknown>): string | undefined {
  const model = message.model;
  if (typeof model === "string" && model) return model;
  if (model && typeof model === "object") {
    const value = model as Record<string, unknown>;
    if (typeof value.id === "string" && value.id) return value.id;
    if (typeof value.name === "string" && value.name) return value.name;
  }
  return undefined;
}

/** Mutable accumulator shared by the batch and incremental telemetry parsers. */
interface TelemetryAccumulator {
  sawSessionHeader: boolean;
  sawAgentEnd: boolean;
  usage?: LoopUsage;
  activity?: WorkerActivity;
  model?: string;
}

function emptyAccumulator(): TelemetryAccumulator {
  return { sawSessionHeader: false, sawAgentEnd: false };
}

/** Consume one already-JSON-parsed session event into `acc`, in place. */
function consumeTelemetryEvent(
  acc: TelemetryAccumulator,
  event: Record<string, unknown>,
): void {
  const type = event.type;
  if (type === "session") {
    acc.sawSessionHeader = true;
    return;
  }
  if (!acc.sawSessionHeader) return; // ignore stray JSON before a real session header
  if (type === "agent_end") {
    acc.sawAgentEnd = true;
    return;
  }
  if (type === "message_end") {
    const message = event.message;
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.role !== "assistant") return;
    acc.usage = acc.usage || { ...ZERO_USAGE };
    acc.activity = acc.activity || { modelRounds: 0, toolCalls: 0, toolResults: 0 };
    addMessageUsage(acc.usage, value);
    acc.activity.modelRounds += 1;
    acc.model = modelFromMessage(value) ?? acc.model;
    return;
  }
  if (type === "tool_execution_start") {
    acc.activity = acc.activity || { modelRounds: 0, toolCalls: 0, toolResults: 0 };
    acc.activity.toolCalls += 1;
    return;
  }
  if (type === "tool_execution_end") {
    acc.activity = acc.activity || { modelRounds: 0, toolCalls: 0, toolResults: 0 };
    acc.activity.toolResults += 1;
    return;
  }
}

/** Consume one raw NDJSON line into `acc`, in place. Never throws. */
function consumeTelemetryLine(acc: TelemetryAccumulator, line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  consumeTelemetryEvent(acc, event);
}

function finishAccumulator(acc: TelemetryAccumulator): WorkerTelemetryReport {
  if (!acc.sawSessionHeader) return { status: "unavailable" };
  return {
    status: acc.sawAgentEnd ? "complete" : "partial",
    usage: acc.usage,
    activity: acc.activity,
    model: acc.model,
  };
}

/**
 * Parse a bounded aggregate telemetry report from an issue worker's `--mode
 * json` NDJSON event stream (docs: `pi-coding-agent/docs/json.md`), sourced
 * from a complete, non-truncated capture of the stream.
 *
 * Deliberately tolerant of non-JSON-mode output: a fixture/test worker that
 * prints arbitrary text (or JSON that isn't a pi session event) yields
 * `unavailable` rather than throwing.
 *
 * `runIssueWorker` does not use this against its own `IssueWorkerResult.output`
 * (that buffer is bounded to a small tail for failure diagnostics and would
 * silently drop the leading `session` event this function requires on any
 * run longer than a few seconds); it uses {@link IncrementalWorkerTelemetryParser}
 * instead, fed from the same unbounded live stream as worker-activity.ts.
 * This function remains the batch entry point for tests and any caller that
 * already holds a complete, untruncated capture.
 */
export function parseWorkerTelemetry(output: string): WorkerTelemetryReport {
  const acc = emptyAccumulator();
  for (const line of output.split(/\r?\n/)) consumeTelemetryLine(acc, line);
  return finishAccumulator(acc);
}

/**
 * Incremental counterpart to {@link parseWorkerTelemetry}, fed chunk-by-chunk
 * from a live child stream exactly like `IncrementalWorkerActivityParser`
 * (worker-activity.ts). Because it aggregates numeric counters/strings
 * instead of retaining the raw stream, it is never subject to the bounded
 * tail-truncation `IssueWorkerResult.output` uses for failure diagnostics —
 * a long-running worker's leading `session` header is never lost.
 */
export class IncrementalWorkerTelemetryParser {
  private readonly acc = emptyAccumulator();
  private pending = "";

  push(chunk: string | Buffer): void {
    this.pending += String(chunk);
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) consumeTelemetryLine(this.acc, line);
  }

  finish(): WorkerTelemetryReport {
    if (this.pending) consumeTelemetryLine(this.acc, this.pending);
    this.pending = "";
    return finishAccumulator(this.acc);
  }
}

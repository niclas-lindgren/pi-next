/** Runtime bridge from typed Pi-next failures to the adapter-neutral reporter. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createFeedbackEvent,
  FeedbackReporter,
  type FeedbackCategory,
  type FeedbackOutcome,
  type FeedbackReport,
  type FeedbackSeverity,
  type FeedbackSinkResult,
  type FeedbackSink,
  type FeedbackDiagnosticContext,
} from "../../src/coordination/feedback.ts";
import { runtimeDir } from "./util-core.ts";

const MAX_FILE_EVENTS = 100;
const reporters = new Map<string, FeedbackReporter>();
const configuredSinks = new Map<string, FeedbackSink>();

/** Local durability is a sink as far as recurrence reporting is concerned;
 * it never leaves the machine and never attempts incident creation. */
class LocalFeedbackSink implements FeedbackSink {
  publish(): FeedbackSinkResult {
    return { status: "published" };
  }
}

export function feedbackFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-feedback.jsonl");
}

function persistFeedbackEvent(cwd: string, event: Parameters<FeedbackSink["publish"]>[0]): void {
  const file = feedbackFile(cwd);
  mkdirSync(runtimeDir(cwd), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_FILE_EVENTS) writeFileSync(file, `${lines.slice(-MAX_FILE_EVENTS).join("\n")}\n`, "utf8");
  } catch {
    // The event was already durably appended; trimming is best effort.
  }
}

function reporter(cwd: string): FeedbackReporter {
  let value = reporters.get(cwd);
  if (!value) {
    // Local persistence is handled by reportRuntimeFailure itself. A
    // configured sink is optional and deliberately typed at this adapter
    // boundary so core never needs to know whether it is GitHub, a queue, or
    // another incident system.
    const sink = process.env.PI_NEXT_FEEDBACK_SINK === "none"
      ? undefined
      : configuredSinks.get(cwd) || new LocalFeedbackSink();
    value = new FeedbackReporter(sink);
    // Reconstruct recurrence from the bounded sanitized event file so a new
    // Pi process does not forget a systemic fingerprint. Restoration never
    // publishes historical events again.
    try {
      const lines = readFileSync(feedbackFile(cwd), "utf8").split("\n").filter(Boolean);
      value.restore(lines.slice(-MAX_FILE_EVENTS).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }));
    } catch {
      // Missing/corrupt telemetry is non-fatal; the next event starts fresh.
    }
    reporters.set(cwd, value);
  }
  return value;
}

export interface RuntimeFailureInput {
  stage: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  outcome: FeedbackOutcome;
  code: string;
  summary: unknown;
  error?: unknown;
  issueNumber?: number;
  runId?: string;
  diagnosticRefs?: unknown[];
  diagnostic?: FeedbackDiagnosticContext;
}

/**
 * Install or replace the consumer-owned incident sink for one coordination
 * root. The sink receives only the already-sanitized FeedbackEvent. Recreate
 * the in-memory reporter so recurrence from the durable local file remains
 * intact when a sink is attached after startup.
 */
export function setRuntimeFeedbackSink(cwd: string, sink: FeedbackSink | undefined): void {
  if (sink) configuredSinks.set(cwd, sink);
  else configuredSinks.delete(cwd);
  reporters.delete(cwd);
}

/** Never throws: incident reporting cannot change the lifecycle outcome. */
export async function reportRuntimeFailure(cwd: string, input: RuntimeFailureInput): Promise<FeedbackReport | undefined> {
  try {
    const event = createFeedbackEvent({ harness: "pi-next", attempt: 1, ...input });
    const instance = reporter(cwd);
    // Immediate/fatal events are already durable on their first occurrence;
    // avoid turning repeated fatal notifications into duplicate incident rows.
    if (event.severity !== "fatal" || instance.recurrence(event.fingerprint) === 0) {
      persistFeedbackEvent(cwd, event);
    }
    return await instance.report(event);
  } catch {
    return undefined;
  }
}

/** Test/process cleanup hook; production keeps one reporter per coordination root. */
export function resetRuntimeFeedback(cwd?: string): void {
  if (cwd) {
    reporters.delete(cwd);
    configuredSinks.delete(cwd);
  } else {
    reporters.clear();
    configuredSinks.clear();
  }
}

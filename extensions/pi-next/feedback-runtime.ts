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
  type FeedbackSink,
} from "../../src/coordination/feedback.ts";
import { runtimeDir } from "./util-core.ts";

const MAX_FILE_EVENTS = 100;
const reporters = new Map<string, FeedbackReporter>();

export function feedbackFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-feedback.jsonl");
}

class LocalFeedbackSink implements FeedbackSink {
  constructor(private readonly cwd: string) {}

  publish(event: Parameters<FeedbackSink["publish"]>[0]): void {
    const file = feedbackFile(this.cwd);
    mkdirSync(runtimeDir(this.cwd), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_FILE_EVENTS) writeFileSync(file, `${lines.slice(-MAX_FILE_EVENTS).join("\n")}\n`, "utf8");
    } catch {
      // The event was already durably appended; trimming is best effort.
    }
  }
}

function reporter(cwd: string): FeedbackReporter {
  let value = reporters.get(cwd);
  if (!value) {
    const sink = process.env.PI_NEXT_FEEDBACK_SINK === "none" ? undefined : new LocalFeedbackSink(cwd);
    value = new FeedbackReporter(sink);
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
}

/** Never throws: incident reporting cannot change the lifecycle outcome. */
export async function reportRuntimeFailure(cwd: string, input: RuntimeFailureInput): Promise<FeedbackReport | undefined> {
  try {
    const event = createFeedbackEvent({ harness: "pi-next", attempt: 1, ...input });
    return await reporter(cwd).report(event);
  } catch {
    return undefined;
  }
}

/** Test/process cleanup hook; production keeps one reporter per coordination root. */
export function resetRuntimeFeedback(cwd?: string): void {
  if (cwd) reporters.delete(cwd);
  else reporters.clear();
}

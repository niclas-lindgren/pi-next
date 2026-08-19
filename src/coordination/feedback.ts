/** Bounded, adapter-neutral runtime feedback and incident evidence. */
import { createHash } from "node:crypto";

export const FEEDBACK_SCHEMA_VERSION = 1 as const;
const MAX_SUMMARY = 500;
const MAX_REFS = 6;
const MAX_EVENTS = 100;

export type FeedbackCategory = "transient" | "runtime" | "repository" | "work" | "external" | "integrity";
export type FeedbackSeverity = "info" | "warning" | "error" | "fatal";
export type FeedbackOutcome = "recovered" | "failed" | "pending" | "escalated";

export interface FeedbackEvent {
  version: typeof FEEDBACK_SCHEMA_VERSION;
  fingerprint: string;
  harness: string;
  runId?: string;
  issueNumber?: number;
  stage: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  outcome: FeedbackOutcome;
  code: string;
  summary: string;
  attempt: number;
  diagnosticRefs: string[];
  at: string;
}

export interface FeedbackPolicy {
  recurringThreshold: number;
  escalateCategories: FeedbackCategory[];
  immediateSeverities: FeedbackSeverity[];
}

export const DEFAULT_FEEDBACK_POLICY: Readonly<FeedbackPolicy> = Object.freeze({
  recurringThreshold: 3,
  escalateCategories: ["integrity", "runtime"] as FeedbackCategory[],
  immediateSeverities: ["fatal"] as FeedbackSeverity[],
});

export interface FeedbackSink {
  publish(event: FeedbackEvent): Promise<void> | void;
}

export interface FeedbackReport {
  event: FeedbackEvent;
  shouldEscalate: boolean;
  sinkStatus: "not-configured" | "published" | "pending" | "failed";
}

function compact(value: unknown, max = MAX_SUMMARY): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Remove credentials, tokens, URLs and machine-specific path data. */
export function sanitizeFeedbackText(value: unknown): string {
  return compact(value)
    .replace(/(?:bearer|token|password|passwd|secret|api[_ -]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s)]+/gi, "[URL]")
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s:]+/g, "[PATH]")
    .replace(/\b(?:ghp|github_pat|sk|xoxb)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

export function feedbackFingerprint(input: Pick<FeedbackEvent, "harness" | "stage" | "category" | "code" | "summary">): string {
  const normalized = [input.harness, input.stage, input.category, input.code, sanitizeFeedbackText(input.summary)
    .replace(/\b\d+\b/g, "#")].join("|").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function createFeedbackEvent(input: Omit<FeedbackEvent, "version" | "fingerprint" | "summary" | "diagnosticRefs" | "at"> & { summary: unknown; diagnosticRefs?: unknown[]; at?: string }): FeedbackEvent {
  const summary = sanitizeFeedbackText(input.summary);
  return {
    version: FEEDBACK_SCHEMA_VERSION,
    fingerprint: feedbackFingerprint({ ...input, summary }),
    harness: compact(input.harness, 80),
    ...(input.runId ? { runId: compact(input.runId, 80) } : {}),
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    stage: compact(input.stage, 80),
    category: input.category,
    severity: input.severity,
    outcome: input.outcome,
    code: compact(input.code, 80),
    summary,
    attempt: Math.max(1, Math.min(999, Math.trunc(input.attempt))),
    diagnosticRefs: (input.diagnosticRefs || []).map((ref) => sanitizeFeedbackText(ref)).filter(Boolean).slice(0, MAX_REFS),
    at: input.at || new Date().toISOString(),
  };
}

export function shouldEscalate(event: FeedbackEvent, recurrence: number, policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY): boolean {
  return policy.immediateSeverities.includes(event.severity) ||
    (policy.escalateCategories.includes(event.category) && recurrence >= policy.recurringThreshold);
}

/** In-memory bounded recurrence reporter; sink failures never recurse into it. */
export class FeedbackReporter {
  private readonly counts = new Map<string, number>();
  private readonly recent: FeedbackEvent[] = [];
  private reporting = false;

  constructor(private readonly sink?: FeedbackSink, private readonly policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY) {}

  events(): readonly FeedbackEvent[] { return this.recent; }

  async report(event: FeedbackEvent): Promise<FeedbackReport> {
    const recurrence = (this.counts.get(event.fingerprint) || 0) + 1;
    this.counts.set(event.fingerprint, recurrence);
    const bounded = { ...event, attempt: Math.min(999, recurrence) };
    this.recent.push(bounded);
    if (this.recent.length > MAX_EVENTS) this.recent.splice(0, this.recent.length - MAX_EVENTS);
    const escalate = shouldEscalate(bounded, recurrence, this.policy);
    if (!escalate || !this.sink || this.reporting) return { event: bounded, shouldEscalate: escalate, sinkStatus: this.sink ? "not-configured" : "not-configured" };
    this.reporting = true;
    try {
      await this.sink.publish(bounded);
      return { event: bounded, shouldEscalate: true, sinkStatus: "published" };
    } catch {
      return { event: bounded, shouldEscalate: true, sinkStatus: "failed" };
    } finally {
      this.reporting = false;
    }
  }
}

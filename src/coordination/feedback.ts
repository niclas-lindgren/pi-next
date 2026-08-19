/** Bounded, adapter-neutral runtime feedback and incident evidence. */
import { createHash } from "node:crypto";

export const FEEDBACK_SCHEMA_VERSION = 1 as const;
const MAX_SUMMARY = 500;
const MAX_REFS = 6;
const MAX_EVENTS = 100;
const MAX_ERROR_MESSAGE = 300;

export type FeedbackCategory = "transient" | "runtime" | "repository" | "work" | "external" | "integrity";
export type FeedbackSeverity = "info" | "warning" | "error" | "fatal";
export type FeedbackOutcome = "recovered" | "failed" | "pending" | "escalated";

export interface FeedbackErrorShape {
  name: string;
  message: string;
}

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
  error?: FeedbackErrorShape;
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

export interface FeedbackSinkResult {
  status: "published" | "pending";
}

export interface FeedbackSink {
  publish(event: FeedbackEvent): Promise<void | FeedbackSinkResult> | void | FeedbackSinkResult;
}

export interface FeedbackReport {
  event: FeedbackEvent;
  shouldEscalate: boolean;
  sinkStatus: "not-configured" | "not-escalated" | "published" | "pending" | "failed" | "suppressed";
}

function compact(value: unknown, max = MAX_SUMMARY): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Remove credentials, tokens, URLs, connection strings, and machine paths. */
export function sanitizeFeedbackText(value: unknown): string {
  return compact(value)
    .replace(/(?:bearer\s+|token|password|passwd|secret|api[_ -]?key|authorization)\s*[=:]?\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+/gi, "[CONNECTION_STRING]")
    .replace(/https?:\/\/[^\s)]+/gi, "[URL]")
    .replace(/\b(?:ghp|github_pat|sk|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(?:^|[\s=(])(?:\/(?:Users|home|tmp|var|workspace)\/[^\s:),]+|[A-Z]:\\[^\s:),]+)/g, "$1[PATH]");
}

function normalizeFingerprintText(value: string): string {
  return sanitizeFeedbackText(value)
    .replace(/\b\d+\b/g, "#")
    .replace(/:\d+(?=\b|\D)/g, ":#")
    .replace(/\s+/g, " ")
    .trim();
}

export function feedbackFingerprint(input: Pick<FeedbackEvent, "harness" | "stage" | "category" | "code" | "summary">): string {
  const normalized = [input.harness, input.stage, input.category, input.code, normalizeFingerprintText(input.summary)].join("|").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

const CATEGORIES: readonly FeedbackCategory[] = ["transient", "runtime", "repository", "work", "external", "integrity"];
const SEVERITIES: readonly FeedbackSeverity[] = ["info", "warning", "error", "fatal"];
const OUTCOMES: readonly FeedbackOutcome[] = ["recovered", "failed", "pending", "escalated"];

function errorShape(value: unknown): FeedbackErrorShape | undefined {
  if (value === undefined || value === null) return undefined;
  const source = value instanceof Error ? value : (typeof value === "object" ? value as Record<string, unknown> : { message: value });
  const name = sanitizeFeedbackText(source.name || "Error").slice(0, 80) || "Error";
  const message = sanitizeFeedbackText(source.message || ("error" in source ? source.error : undefined) || value).slice(0, MAX_ERROR_MESSAGE);
  return { name, message };
}

export type FeedbackEventInput = Omit<FeedbackEvent, "version" | "fingerprint" | "summary" | "error" | "diagnosticRefs" | "at"> & {
  summary: unknown;
  error?: unknown;
  diagnosticRefs?: unknown[];
  at?: string;
};

export function createFeedbackEvent(input: FeedbackEventInput): FeedbackEvent {
  if (!CATEGORIES.includes(input.category)) throw new Error(`unsupported feedback category: ${String(input.category)}`);
  if (!SEVERITIES.includes(input.severity)) throw new Error(`unsupported feedback severity: ${String(input.severity)}`);
  if (!OUTCOMES.includes(input.outcome)) throw new Error(`unsupported feedback outcome: ${String(input.outcome)}`);
  const summary = sanitizeFeedbackText(input.summary);
  const timestamp = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  const event: FeedbackEvent = {
    version: FEEDBACK_SCHEMA_VERSION,
    fingerprint: "",
    harness: compact(input.harness, 80),
    ...(input.runId ? { runId: sanitizeFeedbackText(input.runId).slice(0, 80) } : {}),
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    stage: compact(input.stage, 80),
    category: input.category,
    severity: input.severity,
    outcome: input.outcome,
    code: compact(input.code, 80),
    summary,
    ...(input.error === undefined ? {} : { error: errorShape(input.error) }),
    attempt: Math.max(1, Math.min(999, Number.isFinite(input.attempt) ? Math.trunc(input.attempt) : 1)),
    diagnosticRefs: (input.diagnosticRefs || []).map((ref) => sanitizeFeedbackText(ref)).filter(Boolean).slice(0, MAX_REFS),
    at: timestamp,
  };
  event.fingerprint = feedbackFingerprint(event);
  return event;
}

export function shouldEscalate(event: FeedbackEvent, recurrence: number, policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY): boolean {
  return policy.immediateSeverities.includes(event.severity) ||
    (policy.escalateCategories.includes(event.category) && recurrence >= policy.recurringThreshold);
}

/** In-memory bounded recurrence reporter; sink failures never recurse into it. */
export class FeedbackReporter {
  private readonly counts = new Map<string, number>();
  private readonly recent: FeedbackEvent[] = [];
  private readonly delivered = new Set<string>();
  private reporting = false;

  constructor(private readonly sink?: FeedbackSink, private readonly policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY) {
    if (!Number.isInteger(policy.recurringThreshold) || policy.recurringThreshold < 1) throw new Error("invalid feedback recurrence threshold");
  }

  events(): readonly FeedbackEvent[] { return this.recent; }
  recurrence(fingerprint: string): number { return this.counts.get(fingerprint) || 0; }

  async report(event: FeedbackEvent): Promise<FeedbackReport> {
    const recurrence = (this.counts.get(event.fingerprint) || 0) + 1;
    this.counts.set(event.fingerprint, recurrence);
    const bounded = { ...event, attempt: Math.min(999, recurrence) };
    this.recent.push(bounded);
    if (this.recent.length > MAX_EVENTS) this.recent.splice(0, this.recent.length - MAX_EVENTS);
    const escalate = shouldEscalate(bounded, recurrence, this.policy);
    if (!escalate) return { event: bounded, shouldEscalate: false, sinkStatus: this.sink ? "not-escalated" : "not-configured" };
    if (!this.sink) return { event: bounded, shouldEscalate: true, sinkStatus: "not-configured" };
    if (this.delivered.has(event.fingerprint)) return { event: bounded, shouldEscalate: true, sinkStatus: "suppressed" };
    if (this.reporting) return { event: bounded, shouldEscalate: true, sinkStatus: "pending" };

    this.reporting = true;
    try {
      const result = await this.sink.publish(bounded);
      this.delivered.add(event.fingerprint);
      return { event: bounded, shouldEscalate: true, sinkStatus: result?.status || "published" };
    } catch {
      return { event: bounded, shouldEscalate: true, sinkStatus: "failed" };
    } finally {
      this.reporting = false;
    }
  }
}

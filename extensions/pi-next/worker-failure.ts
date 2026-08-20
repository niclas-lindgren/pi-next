import {
  feedbackFingerprint,
  sanitizeFeedbackText,
  type FeedbackReport,
  type FeedbackSeverity,
} from "../../src/coordination/feedback.ts";
import type { WorkerDispatchPolicy, WorkerModelPolicy } from "../../src/coordination/worker-dispatch.ts";

/** Keep worker diagnostics useful in a terminal without replaying transcripts. */
export const WORKER_DIAGNOSTIC_LIMIT = 1_000;
const WORKER_SUMMARY_LIMIT = 500;

export type WorkerFailureClassification = "runtime" | "repository" | "work" | "external" | "transient";

export interface WorkerFailureEvidence {
  code: string;
  category: WorkerFailureClassification;
  severity: FeedbackSeverity;
  exitCode: number | null;
  signal: string | null;
  issueNumber?: number;
  runId?: string;
  phase?: string;
  role?: WorkerDispatchPolicy["role"];
  modelPolicy?: WorkerModelPolicy;
  diagnosticExcerpt: string;
  /** Stable, sanitized text used for feedback recurrence/fingerprinting. */
  summary: string;
  fingerprint: string;
  diagnosticRefs: string[];
}

export interface WorkerFailureContext {
  issueNumber?: number;
  runId?: string;
  phase?: string;
  dispatch?: WorkerDispatchPolicy;
}

function usefulLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => sanitizeFeedbackText(line))
    .filter(Boolean)
    // JSON event records and progress chatter are not useful after a failed
    // child. Keep them only when they are the only evidence available.
    .filter((line) => !/^\s*(?:\{"type"\s*:\s*"(?:message|session|turn)"|Still running )/i.test(line));
}

/** Extract a short, sanitized tail, preferring lines that describe failure. */
export function extractWorkerDiagnostic(output: unknown, limit = WORKER_DIAGNOSTIC_LIMIT): string {
  const boundedLimit = Math.max(1, Math.min(WORKER_DIAGNOSTIC_LIMIT, Math.trunc(limit)));
  const all = usefulLines(String(output ?? ""));
  const candidates = all.filter((line) => /(?:error|fail|exception|fatal|cannot|unable|denied|invalid|timeout|killed|signal)/i.test(line));
  const selected = (candidates.length ? candidates.slice(-8) : all.slice(-8));
  const excerpt = selected.join("\n");
  return excerpt.slice(-boundedLimit).trim() || "Worker exited without diagnostic output.";
}

function classify(output: string, signal: string | null): WorkerFailureClassification {
  if (signal) return "external";
  // These are deliberately conservative. An ordinary exit 1 belongs to the
  // current work item until evidence identifies a pi-next defect.
  if (/(?:pi[- ]next|loop[- ]controller|worker[- ]dispatch|foreground[- ]supervisor|PI_NEXT_).*(?:error|exception|invariant|assert|failed|failure|bug)/i.test(output) ||
      /(?:cannot find module|module not found).*(?:pi-coding-agent|pi-next)/i.test(output)) {
    return "runtime";
  }
  if (/(?:npm|pnpm|yarn|bun)?\s*(?:test|build|lint|typecheck)|typescript|tsc|eslint|vitest|jest|assertion failed|test failed|merge conflict|conflict marker|git .*failed/i.test(output)) {
    return "repository";
  }
  if (/(?:ENOENT|EACCES|ECONN(?:RESET|REFUSED)|ETIMEDOUT|ENETUNREACH|network|rate limit|timed out|permission denied|authentication failed|TLS|certificate)/i.test(output)) {
    return "external";
  }
  if (/(?:aborted|cancelled|canceled|interrupted|temporary|try again|busy|lock contention)/i.test(output)) {
    return "transient";
  }
  return "work";
}

function severityFor(category: WorkerFailureClassification): FeedbackSeverity {
  return category === "runtime" ? "error" : category === "work" || category === "repository" ? "warning" : "info";
}

function safeModelPolicy(policy: WorkerModelPolicy | undefined): WorkerModelPolicy | undefined {
  if (!policy) return undefined;
  const model = policy.model ? sanitizeFeedbackText(policy.model).slice(0, 120) : undefined;
  const thinking = policy.thinking;
  const escalation = typeof policy.escalation === "number" && Number.isFinite(policy.escalation)
    ? Math.max(0, Math.min(3, Math.trunc(policy.escalation)))
    : undefined;
  return model || thinking || escalation !== undefined
    ? { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(escalation === undefined ? {} : { escalation }) }
    : undefined;
}

function stableSummary(category: WorkerFailureClassification, excerpt: string): string {
  // Sanitization and the feedback fingerprint's numeric normalization make
  // paths, URLs, line numbers, and run-specific values unsuitable as identity.
  return sanitizeFeedbackText(`${category} worker failure: ${excerpt}`).slice(0, WORKER_SUMMARY_LIMIT);
}

export function createWorkerFailureEvidence(
  result: Pick<{ output: string; code: number | null; signal: string | null }, "output" | "code" | "signal">,
  context: WorkerFailureContext = {},
): WorkerFailureEvidence {
  const diagnosticExcerpt = extractWorkerDiagnostic(result.output);
  const category = classify(diagnosticExcerpt, result.signal);
  const summary = stableSummary(category, diagnosticExcerpt);
  const code = `worker_${category}_failure`;
  const modelPolicy = safeModelPolicy(context.dispatch?.modelPolicy);
  const fingerprint = feedbackFingerprint({
    harness: "pi-next",
    stage: context.phase || "worker",
    category,
    code,
    summary,
  });
  return {
    code,
    category,
    severity: severityFor(category),
    exitCode: result.code,
    signal: result.signal,
    ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
    ...(context.runId ? { runId: sanitizeFeedbackText(context.runId).slice(0, 80) } : {}),
    ...(context.phase ? { phase: sanitizeFeedbackText(context.phase).slice(0, 80) } : {}),
    ...(context.dispatch?.role ? { role: context.dispatch.role } : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
    diagnosticExcerpt,
    summary,
    fingerprint,
    diagnosticRefs: ["worker-output-tail"],
  };
}

function incidentDisposition(report: FeedbackReport | undefined, category: WorkerFailureClassification): string {
  if (!report || !report.shouldEscalate) return `Incident: diagnostics only (${category} failure)`;
  switch (report.sinkStatus) {
    case "published": return "Incident: escalated by configured sink";
    case "suppressed": return "Incident: matched existing corrective issue";
    case "pending": return "Incident: pending (sink is busy)";
    case "failed": return "Incident: sink unavailable; local diagnostics retained";
    case "not-configured": return "Incident: pending (sink unavailable)";
    default: return "Incident: pending";
  }
}

export function formatWorkerFailure(
  evidence: WorkerFailureEvidence,
  report?: FeedbackReport,
): string {
  const identity = evidence.issueNumber ? ` while processing #${evidence.issueNumber}` : "";
  const status = evidence.signal ? `Signal: ${evidence.signal}` : `Exit: ${evidence.exitCode ?? "unknown"}`;
  return [
    `Pi worker failed${identity}`,
    status,
    ...(evidence.phase ? [`Phase: ${evidence.phase}`] : []),
    ...(evidence.role ? [`Role: ${evidence.role}`] : []),
    "Last worker output:",
    `  ${evidence.diagnosticExcerpt.replace(/\n/g, "\n  ")}`,
    `Failure fingerprint: ${evidence.fingerprint}`,
    `Diagnostics: ${evidence.diagnosticRefs.join(", ")}`,
    incidentDisposition(report, evidence.category),
  ].join("\n");
}

export class WorkerFailureError extends Error {
  readonly code = "worker_failure" as const;
  constructor(
    readonly evidence: WorkerFailureEvidence,
    readonly feedback?: FeedbackReport,
  ) {
    super(formatWorkerFailure(evidence, feedback));
    this.name = "WorkerFailureError";
  }
}

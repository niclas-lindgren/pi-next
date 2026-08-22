import { ReviewerFinding, ReviewerResult } from "./types.js";
import { redact } from "./utils.js";

export function extractAssistantTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; assistantMessageEvent?: unknown };
  if (item.type !== "message_update" || !item.assistantMessageEvent || typeof item.assistantMessageEvent !== "object") return undefined;
  const assistantEvent = item.assistantMessageEvent as { type?: unknown; delta?: unknown };
  return assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
}

export function parseReviewResultText(text: string | undefined): ReviewerResult | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return sanitizeReviewResult(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function sanitizeReviewResult(value: unknown): ReviewerResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as { verdict?: unknown; findings?: unknown };
  if (item.verdict === "pass") return { verdict: "pass" };
  if (item.verdict !== "findings" || !Array.isArray(item.findings)) return undefined;
  const findings = item.findings.slice(0, 20).map((finding): ReviewerFinding | undefined => {
    if (!finding || typeof finding !== "object") return undefined;
    const raw = finding as { severity?: unknown; path?: unknown; summary?: unknown };
    if (raw.severity !== "blocking" && raw.severity !== "warning") return undefined;
    if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) return undefined;
    const sanitized: ReviewerFinding = { severity: raw.severity, summary: redact(raw.summary).slice(0, 500) };
    if (typeof raw.path === "string" && raw.path.length <= 300 && !raw.path.includes("\0")) sanitized.path = raw.path;
    return sanitized;
  });
  if (findings.some((finding) => finding === undefined)) return undefined;
  return { verdict: "findings", findings: findings as ReviewerFinding[] };
}

export function reviewPassed(result: ReviewerResult | undefined): boolean {
  return result?.verdict === "pass" || (result?.verdict === "findings" && !(result.findings ?? []).some((finding) => finding.severity === "blocking"));
}

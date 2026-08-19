/** Bounded candidate review primitives. Reviewers never own lifecycle state. */
import type { WorkerDispatchPolicy } from "./worker-dispatch.ts";

export type ReviewAxis = "spec" | "standards" | "risk";
export type ReviewFindingSeverity = "blocking" | "non-blocking";

export interface ReviewBinding {
  issueNumber: number;
  candidateSha: string;
  fixedPointSha: string;
  authorityFingerprint: string;
}

export interface ReviewRequest extends ReviewBinding {
  axis: ReviewAxis;
  round: number;
  dispatch: WorkerDispatchPolicy;
}

export interface ReviewFinding {
  summary: string;
  evidence: string;
  severity: ReviewFindingSeverity;
  /** Preferences and formatting cannot block a candidate. */
  concrete: boolean;
}

export interface ReviewResult extends ReviewBinding {
  axis: ReviewAxis;
  round: number;
  verdict: "pass" | "findings";
  findings: ReviewFinding[];
  reviewerId: string;
}

export interface AdversarialReviewPolicy {
  enabled: boolean;
  requiredRisk: "high" | "critical";
  maxRounds: number;
  axes: ReviewAxis[];
}

export const DEFAULT_ADVERSARIAL_REVIEW_POLICY: Readonly<AdversarialReviewPolicy> = Object.freeze({
  enabled: false,
  requiredRisk: "high",
  maxRounds: 2,
  axes: ["spec", "standards"] as ReviewAxis[],
});

export function requiresAdversarialReview(
  risk: "low" | "normal" | "high" | "critical" | undefined,
  policy: AdversarialReviewPolicy = DEFAULT_ADVERSARIAL_REVIEW_POLICY,
): boolean {
  return policy.enabled && (risk === "critical" || (risk === "high" && policy.requiredRisk === "high"));
}

export function assertReviewBinding(expected: ReviewBinding, actual: ReviewBinding): void {
  for (const key of ["issueNumber", "candidateSha", "fixedPointSha", "authorityFingerprint"] as const) {
    if (expected[key] !== actual[key]) throw new Error(`stale review binding: ${key} changed`);
  }
}

export function concreteBlockingFindings(result: ReviewResult): ReviewFinding[] {
  return result.findings.filter((finding) => finding.severity === "blocking" && finding.concrete && finding.evidence.trim());
}

export function reviewPasses(result: ReviewResult): boolean {
  return result.verdict === "pass" && concreteBlockingFindings(result).length === 0;
}

export function validateReviewResult(expected: ReviewBinding, result: ReviewResult): void {
  assertReviewBinding(expected, result);
  if (!result.reviewerId.trim()) throw new Error("review result requires reviewer identity");
  if (result.verdict === "pass" && concreteBlockingFindings(result).length) throw new Error("passing review has blocking findings");
}

/** Runtime guard used by host adapters before executing reviewer actions. */
export function assertReviewerActionAllowed(action: "read" | "write" | "commit" | "promote" | "close" | "ownership"): void {
  if (action !== "read") throw new Error(`read-only reviewer cannot perform ${action}`);
}

export function nextReviewRound(round: number, policy: AdversarialReviewPolicy): number {
  if (!Number.isInteger(round) || round < 0) throw new Error("invalid review round");
  if (round >= policy.maxRounds) throw new Error(`adversarial review rounds exhausted (${policy.maxRounds})`);
  return round + 1;
}

/** A repair creates a new candidate; no previous review can be reused. */
export function invalidateReviewBinding(binding: ReviewBinding, candidateSha: string): ReviewBinding {
  if (!candidateSha || candidateSha === binding.candidateSha) throw new Error("repair must produce a new candidate SHA");
  return { ...binding, candidateSha };
}

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

/** A fresh, read-only reviewer context. It contains no mutable lifecycle handle. */
export interface ReviewContext {
  readonly reviewerId: string;
  readonly axis: ReviewAxis;
  readonly round: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface ReviewTelemetry {
  rounds: number;
  reviewerIds: string[];
  axes: ReviewAxis[];
  blockingFindings: number;
}

export interface AdversarialReviewResult {
  status: "bypassed" | "passed" | "blocked";
  binding: ReviewBinding;
  results: ReviewResult[];
  telemetry: ReviewTelemetry;
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
  if (!Number.isInteger(result.round) || result.round < 0) throw new Error("review result requires a valid round");
  if (!["spec", "standards", "risk"].includes(result.axis)) throw new Error("review result requires a valid axis");
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

export type ReviewContextFactory = (axis: ReviewAxis, round: number) => Promise<ReviewContext> | ReviewContext;
export type ReviewExecutor = (request: ReviewRequest, context: ReviewContext) => Promise<ReviewResult>;

function defaultReviewContext(axis: ReviewAxis, round: number): ReviewContext {
  return { reviewerId: `reviewer-${round + 1}-${axis}`, axis, round };
}

/**
 * Execute the bounded review gate. Each axis receives a fresh context and the
 * returned result is rejected unless it describes the exact request. A repair
 * callback must produce a new candidate SHA, which mechanically invalidates
 * every result from the previous round.
 */
export async function runBoundedAdversarialReview(input: {
  binding: ReviewBinding;
  risk?: "low" | "normal" | "high" | "critical";
  policy?: AdversarialReviewPolicy;
  dispatch: (axis: ReviewAxis, binding: ReviewBinding, round: number) => WorkerDispatchPolicy;
  execute: ReviewExecutor;
  createContext?: ReviewContextFactory;
  repair?: (findings: readonly ReviewFinding[], binding: ReviewBinding, round: number) => Promise<ReviewBinding>;
}): Promise<AdversarialReviewResult> {
  const policy = input.policy || DEFAULT_ADVERSARIAL_REVIEW_POLICY;
  if (!requiresAdversarialReview(input.risk, policy)) {
    return { status: "bypassed", binding: input.binding, results: [], telemetry: { rounds: 0, reviewerIds: [], axes: [], blockingFindings: 0 } };
  }
  if (!policy.axes.length) throw new Error("adversarial review requires at least one axis");
  if (!Number.isInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 2) throw new Error("invalid adversarial review round bound");

  let binding = input.binding;
  const results: ReviewResult[] = [];
  const reviewerIds: string[] = [];
  const axes: ReviewAxis[] = [];
  for (let round = 0; round < policy.maxRounds; round += 1) {
    const roundFindings: ReviewFinding[] = [];
    for (const axis of [...new Set(policy.axes)]) {
      const context = await (input.createContext || defaultReviewContext)(axis, round);
      assertReviewerActionAllowed("read");
      if (context.axis !== axis || context.round !== round || !context.reviewerId.trim()) {
        throw new Error("review context does not identify its requested fresh axis and round");
      }
      const result = await input.execute({ ...binding, axis, round, dispatch: input.dispatch(axis, binding, round) }, context);
      validateReviewResult(binding, result);
      if (result.axis !== axis || result.round !== round) throw new Error("review result axis or round does not match request");
      results.push(result);
      reviewerIds.push(result.reviewerId);
      axes.push(axis);
      roundFindings.push(...concreteBlockingFindings(result));
    }
    if (!roundFindings.length) {
      return { status: "passed", binding, results, telemetry: { rounds: round + 1, reviewerIds, axes, blockingFindings: 0 } };
    }
    if (!input.repair || round + 1 >= policy.maxRounds) {
      return { status: "blocked", binding, results, telemetry: { rounds: round + 1, reviewerIds, axes, blockingFindings: results.flatMap(concreteBlockingFindings).length } };
    }
    binding = await input.repair(roundFindings, binding, round);
    if (binding.candidateSha === input.binding.candidateSha && round === 0) {
      throw new Error("review repair must produce a new candidate SHA");
    }
  }
  throw new Error("unreachable adversarial review state");
}

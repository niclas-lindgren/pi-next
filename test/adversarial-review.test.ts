import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReviewerActionAllowed,
  concreteBlockingFindings,
  invalidateReviewBinding,
  nextReviewRound,
  requiresAdversarialReview,
  reviewPasses,
  runBoundedAdversarialReview,
  validateReviewResult,
} from "../src/coordination/adversarial-review.ts";
import { createWorkerDispatch } from "../src/coordination/worker-dispatch.ts";

const binding = { issueNumber: 7, candidateSha: "c1", fixedPointSha: "m1", authorityFingerprint: "a1" };
const pass = { ...binding, axis: "spec" as const, round: 0, reviewerId: "reviewer-1", verdict: "pass" as const, findings: [] };

test("high risk review is bounded and separate from normal low-risk work", () => {
  assert.equal(requiresAdversarialReview("low"), false);
  assert.equal(requiresAdversarialReview("high", { enabled: true, requiredRisk: "high", maxRounds: 2, axes: ["spec"] }), true);
  assert.equal(nextReviewRound(0, { enabled: true, requiredRisk: "high", maxRounds: 2, axes: ["spec"] }), 1);
  assert.throws(() => nextReviewRound(2, { enabled: true, requiredRisk: "high", maxRounds: 2, axes: ["spec"] }), /exhausted/);
});

test("review results are exact candidate/authority scoped", () => {
  validateReviewResult(binding, pass);
  assert.equal(reviewPasses(pass), true);
  assert.throws(() => validateReviewResult(binding, { ...pass, candidateSha: "c2" }), /candidateSha/);
  assert.deepEqual(invalidateReviewBinding(binding, "c2"), { ...binding, candidateSha: "c2" });
});

test("only concrete evidence-backed findings block", () => {
  const result = { ...pass, verdict: "findings" as const, findings: [
    { summary: "style preference", evidence: "", severity: "blocking" as const, concrete: false },
    { summary: "missing authorization check", evidence: "path:line", severity: "blocking" as const, concrete: true },
  ] };
  assert.equal(concreteBlockingFindings(result).length, 1);
  assert.equal(reviewPasses(result), false);
});

test("reviewer action guard is mechanically read-only", () => {
  assertReviewerActionAllowed("read");
  assert.throws(() => assertReviewerActionAllowed("write"), /read-only/);
  assert.throws(() => assertReviewerActionAllowed("promote"), /read-only/);
});

test("bounded review creates independent axis contexts and invalidates repaired candidates", async () => {
  const contexts: string[] = [];
  const candidates: string[] = [];
  const result = await runBoundedAdversarialReview({
    binding,
    risk: "high",
    policy: { enabled: true, requiredRisk: "high", maxRounds: 2, axes: ["spec", "standards"] },
    dispatch: (axis, candidate, round) => createWorkerDispatch({ phase: `review-${axis}`, issueNumber: candidate.issueNumber, candidateSha: candidate.candidateSha, fixedPointSha: candidate.fixedPointSha, authorityFingerprint: candidate.authorityFingerprint, task: `review round ${round}` }),
    createContext: (axis, round) => {
      const context = { reviewerId: `fresh-${axis}-${round}`, axis, round } as const;
      contexts.push(context.reviewerId);
      return context;
    },
    execute: async (request, context) => ({
      ...request,
      reviewerId: context.reviewerId,
      verdict: request.round === 0 && request.axis === "spec" ? "findings" : "pass",
      findings: request.round === 0 && request.axis === "spec"
        ? [{ summary: "missing check", evidence: "src/auth.ts:10", severity: "blocking" as const, concrete: true }]
        : [],
    }),
    repair: async (_findings, current) => {
      candidates.push(current.candidateSha);
      return invalidateReviewBinding(current, "c2");
    },
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(contexts, ["fresh-spec-0", "fresh-standards-0", "fresh-spec-1", "fresh-standards-1"]);
  assert.deepEqual(candidates, ["c1"]);
  assert.deepEqual(result.telemetry.axes, ["spec", "standards", "spec", "standards"]);
  assert.equal(result.binding.candidateSha, "c2");
});

test("persistent review findings become a bounded blocked result", async () => {
  const result = await runBoundedAdversarialReview({
    binding,
    risk: "critical",
    policy: { enabled: true, requiredRisk: "critical", maxRounds: 2, axes: ["risk"] },
    dispatch: () => createWorkerDispatch({ phase: "review-spec", issueNumber: 7, candidateSha: "c1", fixedPointSha: "m1", authorityFingerprint: "a1" }),
    execute: async (request, context) => ({
      ...request,
      reviewerId: context.reviewerId,
      verdict: "findings",
      findings: [{ summary: "unsafe", evidence: "test evidence", severity: "blocking", concrete: true }],
    }),
    repair: async (_findings, current, round) => invalidateReviewBinding(current, `c${round + 2}`),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.telemetry.rounds, 2);
  assert.equal(result.results.length, 2);
});

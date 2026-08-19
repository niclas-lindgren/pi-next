import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReviewerActionAllowed,
  concreteBlockingFindings,
  invalidateReviewBinding,
  nextReviewRound,
  requiresAdversarialReview,
  reviewPasses,
  validateReviewResult,
} from "../src/coordination/adversarial-review.ts";

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

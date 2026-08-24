import assert from "node:assert/strict";
import { test } from "node:test";

import { runVerificationSequence } from "../src/coordination/verification-sequence.ts";

test("failing mechanical checks short-circuit to repairable-failure, regardless of any criterion stage", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [
      { command: "npm run typecheck", passed: true },
      { command: "npm test", passed: false },
    ],
    mechanicalFailureEvidence: "npm test exited 1",
    criterionStage: { status: "PASS" },
  });
  assert.deepEqual(result, {
    kind: "resolved",
    mechanicalPass: false,
    lifecycleDisposition: { disposition: "repairable-failure", reason: "npm test exited 1" },
  });
});

test("no mechanical checks at all is not a pass", () => {
  const result = runVerificationSequence({ mechanicalChecks: [] });
  assert.equal(result.kind, "resolved");
  assert.equal(result.mechanicalPass, false);
});

test("mechanical pass with no criterion stage resolves pass (bootstrap's existing shape)", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [{ command: "npm run typecheck", passed: true }, { command: "npm test", passed: true }],
  });
  assert.deepEqual(result, {
    kind: "resolved",
    mechanicalPass: true,
    lifecycleDisposition: { disposition: "pass", reason: undefined },
  });
});

test("mechanical pass with a passing criterion stage resolves pass", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [{ command: "npm test", passed: true }],
    criterionStage: { status: "PASS" },
  });
  assert.equal(result.kind, "resolved");
  assert.equal((result as { lifecycleDisposition: { disposition: string } }).lifecycleDisposition.disposition, "pass");
});

test("mechanical pass with a failing criterion stage routes through its failure disposition", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [{ command: "npm test", passed: true }],
    criterionStage: { status: "FAIL", failureDisposition: "DEFER_ISSUE" },
  });
  assert.deepEqual(result, {
    kind: "resolved",
    mechanicalPass: true,
    lifecycleDisposition: { disposition: "defer-issue", verificationFailureDisposition: "DEFER_ISSUE", reason: undefined },
  });
});

test("a failing criterion stage with no explicit failure disposition defaults to REPAIR/semantic-repair", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [{ command: "npm test", passed: true }],
    criterionStage: { status: "FAIL" },
  });
  assert.equal(result.kind, "resolved");
  const resolved = result as { lifecycleDisposition: { disposition: string; verificationFailureDisposition?: string } };
  assert.equal(resolved.lifecycleDisposition.disposition, "semantic-repair");
  assert.equal(resolved.lifecycleDisposition.verificationFailureDisposition, "REPAIR");
});

test("unresolved criteria (EXTERNAL/UNPROVEN, no FAIL) is reported as needs-review, not forced into a disposition", () => {
  const result = runVerificationSequence({
    mechanicalChecks: [{ command: "npm test", passed: true }],
    criterionStage: { status: "NEEDS_REVIEW", unresolvedCriteria: ["legal counsel confirms refund policy compliance"] },
  });
  assert.deepEqual(result, {
    kind: "needs-review",
    mechanicalPass: true,
    unresolvedCriteria: ["legal counsel confirms refund policy compliance"],
  });
});

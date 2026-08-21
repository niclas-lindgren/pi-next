import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  assessIssueBoundary,
  emptyHealthState,
  evaluateAdaptation,
  evaluateHealth,
  normalizeIssueMetrics,
} from "../src/coordination/self-assessment.ts";
import {
  observeManagedTransition,
  readSelfAssessmentFindings,
} from "../extensions/pi-next/self-assessment.ts";

const policy = {
  enabled: true,
  noProgressThreshold: 2,
  repeatedFailureThreshold: 2,
  repeatedCommandThreshold: 2,
  contextPressureThreshold: 0.8,
  findingRecurrenceThreshold: 2,
  findingMinConfidence: "high" as const,
  findingLabels: ["agent:finding"],
  heldStates: ["pending_review"],
  approvedStates: ["approved"],
};

test("online health escalates repeated failures without changing workflow authority", () => {
  const first = evaluateHealth(emptyHealthState(), {
    transitionType: "failed",
    failureFingerprint: "same-failure",
  });
  const second = evaluateHealth(first.state, {
    transitionType: "failed",
    failureFingerprint: "same-failure",
  });
  assert.equal(second.strategy, "escalate");
  assert.match(second.reason, /repeated/);
});

test("normalization compares comparable workload cohorts", () => {
  const make = (tasks: number, files: number, tokens: number) => normalizeIssueMetrics({
    freshTokens: tokens,
    costUsd: 1,
    wallMs: 100,
    complexity: {
      plannedTasks: tasks,
      acceptanceCriteria: tasks,
      changedFiles: files,
      sourceFiles: files,
      testFiles: 0,
      docsFiles: 0,
      migrationFiles: 0,
      additions: 1,
      deletions: 1,
    },
  });
  const current = make(1, 1, 7000);
  const result = assessIssueBoundary(current, [make(1, 1, 1000), make(1, 1, 3000)]);
  assert.equal(result.comparablePeers, 2);
  assert.match(result.regressions[0] || "", /tokens\/task/);
});

test("reversible regression is explicitly rollback-eligible", () => {
  const result = evaluateAdaptation([100, 100], [140, 140], { reversible: true });
  assert.equal(result.state, "regressed");
  assert.equal(result.rollback, true);
});

test("repeated inner-tool failures escalate while productive red tests stay evidence", () => {
  const repeated = evaluateHealth(emptyHealthState(), {
    transitionType: "transition",
    failureFingerprints: ["same-tool-failure", "same-tool-failure"],
  });
  assert.equal(repeated.strategy, "escalate");

  const expected = evaluateHealth(emptyHealthState(), {
    transitionType: "transition",
    failureFingerprints: ["red-test", "red-test"],
    expectedFailureFingerprints: ["red-test"],
  });
  assert.equal(expected.strategy, "none");
});

test("systemic findings persist and remain held for authority review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-assessment-"));
  try {
    await observeManagedTransition(cwd, { transitionType: "failed", failureFingerprint: "x", runId: "run-1", issueNumber: 7 }, { assessment: policy });
    const result = await observeManagedTransition(cwd, { transitionType: "failed", failureFingerprint: "x", runId: "run-1", issueNumber: 7 }, { assessment: policy });
    assert.equal(result.assessment.strategy, "escalate");
    const findings = readSelfAssessmentFindings(cwd);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.approvalState, "pending_review");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

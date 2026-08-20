import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autoLifecyclePhase,
  renderAutoProgress,
  settledIssueCount,
  settledIssuePercent,
} from "../extensions/pi-next/auto-progress.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    version: 1,
    runId: "progress-test",
    requestedIssues: 5,
    remainingIssues: 5,
    step: 0,
    settledStep: 0,
    maxSteps: 500,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
    ...overrides,
  };
}

test("auto progress starts at 0/N and never uses maxSteps as completion", () => {
  const output = renderAutoProgress(state({ maxSteps: 500 }), { width: 120 });
  assert.match(output, /0\/5 settled 0%/);
  assert.doesNotMatch(output, /500/);
});

test("completed, deferred, and blocked issues all count as settled", () => {
  const current = state({
    completedIssues: [1, 1],
    deferredIssues: [
      { issueNumber: 2, reason: "blocked", deferredAt: new Date().toISOString(), kind: "blocked" },
      { issueNumber: 3, reason: "later", deferredAt: new Date().toISOString(), kind: "deferred" },
    ],
  });
  assert.equal(settledIssueCount(current), 3);
  assert.equal(settledIssuePercent(5, 3), 60);
  assert.match(renderAutoProgress(current, { width: 120 }), /3\/5 settled 60%/);
  assert.match(renderAutoProgress(current, { width: 120 }), /✓1 ↷2/);
});

test("active issue and worker phase are visible", () => {
  const current = state({ activeIssueNumber: 642, step: 73 });
  const output = renderAutoProgress(current, {
    width: 120,
    supervisor: {
      workerAlive: true,
      workerLiveness: "alive",
      elapsedMs: 47 * 60_000,
      workerPhase: "implementation",
    },
  });
  assert.match(output, /#642 · implementing/);
  assert.match(output, /step 73/);
  assert.match(output, /47m/);
  assert.equal(autoLifecyclePhase(current, { workerAlive: true, workerLiveness: "alive", elapsedMs: 0, workerPhase: "verification" }), "verifying");
});

test("recovery and terminal states are explicit", () => {
  const recovering = state({
    activeIssueNumber: 9,
    recovery: {
      missingLoopResults: 1,
      automaticSettlements: 0,
      automaticResumes: 1,
      exhausted: 0,
      attemptsByFingerprint: {},
      lastOutcome: "resuming_same_issue",
    },
  });
  assert.match(renderAutoProgress(recovering, { width: 120 }), /recovering/);
  assert.match(renderAutoProgress(state({ status: "completed", remainingIssues: 0, completedIssues: [1, 2, 3, 4, 5] }), { width: 120 }), /100%.*complete/);
});

test("narrow terminals stay on one line and retain issue, phase, and count", () => {
  const output = renderAutoProgress(
    state({ activeIssueNumber: 642, completedIssues: [1] }),
    { width: 32, supervisor: { workerAlive: true, workerLiveness: "alive", elapsedMs: 0, workerPhase: "verification" } },
  );
  assert.ok(output.length <= 32);
  assert.match(output, /#642/);
  assert.match(output, /verifying/);
  assert.match(output, /1\/5/);
  assert.doesNotMatch(output, /\n/);
});

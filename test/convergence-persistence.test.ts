import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { runOneStep } from "../extensions/pi-next/loop-controller.ts";
import { createSupervisorRuntime } from "../extensions/pi-next/supervisor-runtime.ts";
import {
  emptyLoopMetrics,
  loopStateFile,
  type LoopState,
} from "../extensions/pi-next/loop-state.ts";
import type { IssueWorkerRunner } from "../extensions/pi-next/util-core.ts";

const PLAN = `# Plan: Issue #62

**Goal:** verify scheduler-only convergence yielding

**GitHub-Issue:** #62

## Tasks

- [ ] Exercise the scheduler-only yield boundary
  - Files: extensions/pi-next/loop-controller.ts, test/convergence-persistence.test.ts
  - Approach: run the controller with an exhausted post-baseline budget and inspect durable state.

## Acceptance Criteria

- [ ] The issue is yielded without opening a worker step.

## Log
`;

function state(cwd: string): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: "convergence-persistence",
    sessionId: "session-convergence",
    requestedIssues: 1,
    remainingIssues: 1,
    step: 7,
    settledStep: 6,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [{
      ...emptyLoopMetrics(),
      issueNumber: 62,
      disposition: "active",
      updatedAt: now,
      totalTokens: 4_000_000,
      budgetPolicyVersion: 1,
      budgetBaselineTokens: 0,
      budgetBaselineTransitions: 0,
      budgetBaselineWallClockMs: 0,
    }],
    status: "running",
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
    metrics: emptyLoopMetrics(),
    coordinationCwd: cwd,
    activeIssueNumber: 62,
    activeWorkspace: join(cwd, ".worktrees", "issue-62"),
  };
}

test("real scheduler-only convergence yield persists state and leaves worker progression available", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-convergence-persistence-"));
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    await writeFile(join(cwd, ".pi-next", "PLAN.md"), PLAN);
    const initial = state(cwd);
    let workerCalls = 0;
    const worker: IssueWorkerRunner = async () => {
      workerCalls += 1;
      throw new Error("scheduler-only budget gate must not launch a worker");
    };

    const settlement = await runOneStep(
      { cwd } as unknown as ExtensionCommandContext,
      initial,
      0,
      worker,
      createSupervisorRuntime(),
    );

    assert.equal(workerCalls, 0);
    assert.equal(settlement.terminal, false);
    assert.equal(settlement.outcome, "yield_issue");
    assert.equal(settlement.state.step, initial.step);
    assert.equal(settlement.state.settledStep, initial.settledStep);
    assert.equal(settlement.state.activeWorkspace, initial.activeWorkspace);
    assert.equal(settlement.state.deferredIssues[0]?.kind, "yielded");
    assert.equal(settlement.state.deferredIssues[0]?.issueNumber, 62);
    assert.equal(await readFile(join(cwd, ".pi-next", "PLAN.md"), "utf8"), PLAN);

    const durable = JSON.parse(await readFile(loopStateFile(cwd, initial.runId), "utf8")) as LoopState;
    assert.equal(durable.lastOutcome, "yield_issue");
    assert.equal(durable.step, initial.step);
    assert.equal(durable.settledStep, initial.settledStep);
    assert.equal(durable.activeWorkspace, initial.activeWorkspace);
    assert.equal(durable.deferredIssues[0]?.kind, "yielded");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

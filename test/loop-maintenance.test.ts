import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";
import { issueBoundaryMaintenanceDecision } from "../extensions/pi-next/loop-maintenance.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}

function issueMetrics(issueNumber: number, freshTokens: number) {
  return {
    ...emptyLoopMetrics(),
    issueNumber,
    disposition: "completed" as const,
    input: freshTokens,
    updatedAt: new Date().toISOString(),
  };
}

async function fixture(tasks: number, currentTokens: number): Promise<{ cwd: string; state: LoopState }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-maintenance-decision-"));
  await git(cwd, "init", "--initial-branch=main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "pi-next test");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "current.ts"), "export const current = true;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "implement current issue");
  const sourceCommit = await git(cwd, "rev-parse", "HEAD");
  const plan = [
    "# Plan",
    "",
    "## Tasks",
    ...Array.from({ length: tasks }, (_, index) => `- [x] task ${index + 1}`),
    "",
    "## Acceptance Criteria",
    ...Array.from({ length: tasks }, (_, index) => `- [x] criterion ${index + 1}`),
    "",
    "## Log",
    `- ${sourceCommit}`,
    "",
  ].join("\n");
  await mkdir(join(cwd, ".pi-next", "ARCHIVED"), { recursive: true });
  await writeFile(join(cwd, ".pi-next", "ARCHIVED", "PLAN-3.md"), plan);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "chore(agent): archive issue #3 plan");

  const diagnostics = join(cwd, ".pi-next", "diagnostics");
  await mkdir(diagnostics, { recursive: true });
  const peer = (issueNumber: number) => ({
    schemaVersion: 2,
    issueNumber,
    product: { freshTokens: 70_000, costUsd: 1, transitionWallMs: 10_000 },
    complexity: {
      plannedTasks: 1,
      acceptanceCriteria: 1,
      changedFiles: 1,
      sourceFiles: 1,
      testFiles: 0,
      docsFiles: 0,
      migrationFiles: 0,
      additions: 1,
      deletions: 0,
    },
    maintenance: { freshTokenOverheadShare: 0, costOverheadShare: 0, wallOverheadShare: 0 },
  });
  await writeFile(join(diagnostics, "metrics.jsonl"), `${JSON.stringify(peer(1))}\n${JSON.stringify(peer(2))}\n`);

  const state: LoopState = {
    version: 1,
    runId: "run-1",
    requestedIssues: 3,
    remainingIssues: 0,
    step: 3,
    settledStep: 3,
    maxSteps: 20,
    completedIssues: [1, 2, 3],
    deferredIssues: [],
    issueMetrics: [issueMetrics(1, 70_000), issueMetrics(2, 70_000), issueMetrics(3, currentTokens)],
    status: "running",
    stopRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
  };
  return { cwd, state };
}

test("raw expensive work is not tuned when complexity-normalized peers explain it", async () => {
  const { cwd, state } = await fixture(10, 700_000);
  try {
    const decision = await issueBoundaryMaintenanceDecision(cwd, state);
    assert.ok(decision);
    assert.equal(decision.shouldTune, false);
    assert.doesNotMatch(decision.summary, /fresh token use is a clear outlier/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inconclusive tuning blocks stacking until a new issue supplies evidence", async () => {
  const { cwd, state } = await fixture(1, 70_000);
  try {
    await mkdir(join(cwd, ".pi", "runtime"), { recursive: true });
    await writeFile(join(cwd, ".pi", "runtime", "pi-next-loop-maintenance.json"), JSON.stringify({
      version: 2,
      runId: state.runId,
      lastCompletedCount: 3,
      history: [{
        runId: state.runId,
        issueNumber: 3,
        completedCount: 3,
        checkedAt: new Date().toISOString(),
        reasons: ["previous anomaly"],
        tuningRequested: true,
        tuningRan: true,
        assessment: { status: "change_applied", action: { changed: true }, evaluateAfterIssues: 3 },
        evaluation: {
          state: "inconclusive",
          afterIssues: 3,
          observed: { issueNumbers: [3], promptsAverage: 1, freshTokensAverage: 70_000, modelDurationMsAverage: 1 },
        },
      }],
    }));
    const decision = await issueBoundaryMaintenanceDecision(cwd, state);
    assert.ok(decision);
    assert.equal(decision.shouldTune, false);
    assert.match(decision.reasons.join("; "), /inconclusive/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("complexity-normalized outliers trigger boundary maintenance", async () => {
  const { cwd, state } = await fixture(1, 700_000);
  try {
    const decision = await issueBoundaryMaintenanceDecision(cwd, state);
    assert.ok(decision);
    assert.equal(decision.shouldTune, true);
    assert.match(decision.reasons.join("; "), /complexity-normalized outlier: fresh tokens\/task/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

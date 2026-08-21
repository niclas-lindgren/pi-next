import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyLoopStates,
  renderLoopStatus,
  selectCurrentLoop,
} from "../extensions/pi-next/loop-status.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";

function state(runId: string, overrides: Partial<LoopState> = {}): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    sessionId: "session-a",
    requestedIssues: 1,
    remainingIssues: 1,
    step: 1,
    settledStep: 0,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
    metrics: emptyLoopMetrics(),
    ...overrides,
  };
}

async function persist(cwd: string, value: LoopState, lock?: string): Promise<void> {
  const dir = join(cwd, ".pi", "runtime", "pi-next-loops", value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(value));
  if (lock !== undefined) await writeFile(join(dir, "controller.lock"), lock);
}

test("durable running state is only presented as live with valid live controller evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-loop-status-liveness-"));
  try {
    const live = state("live-run");
    const dead = state("dead-run");
    const missing = state("missing-run");
    await persist(cwd, live, "run_id=live-run\npid=101\n");
    await persist(cwd, dead, "run_id=dead-run\npid=202\n");
    await persist(cwd, missing);

    const records = classifyLoopStates(cwd, [live, dead, missing], { processAlive: (pid) => pid === 101 });
    assert.equal(records[0].presentation, "running");
    assert.equal(records[0].controller, "alive");
    assert.equal(records[1].presentation, "abandoned");
    assert.equal(records[1].controller, "dead");
    assert.equal(records[2].presentation, "unknown");
    assert.equal(records[2].controller, "unknown");
    assert.doesNotMatch(renderLoopStatus(cwd, "session-a", undefined, "verbose", { processAlive: (pid) => pid === 101 }), /missing-run · .* · running/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("current run selection uses session identity and refuses ambiguous history", () => {
  const now = new Date().toISOString();
  const record = (runId: string, controller: "alive" | "dead", sessionId = "session-a") => ({
    state: state(runId, { sessionId, updatedAt: now }),
    controller,
    presentation: controller === "alive" ? "running" as const : "abandoned" as const,
  });
  const selected = selectCurrentLoop([
    record("old", "dead"),
    record("live", "alive"),
    record("foreign", "alive", "session-b"),
  ], undefined, "session-a");
  assert.equal(selected.current?.state.runId, "live");
  assert.equal(selectCurrentLoop([record("a", "dead"), record("b", "dead")], undefined, "session-a").ambiguous, true);
  assert.equal(selectCurrentLoop([record("foreign", "alive", "session-b")], undefined, "session-a").current, undefined);
});

test("status exposes budget baseline and post-activation consumption", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-loop-status-budget-"));
  try {
    const value = state("budget-run", {
      activeIssueNumber: 638,
      issueMetrics: [{
        ...emptyLoopMetrics(),
        issueNumber: 638,
        disposition: "active",
        updatedAt: new Date().toISOString(),
        totalTokens: 5_050_000,
        budgetPolicyVersion: 1,
        budgetBaselineTokens: 5_000_000,
        budgetBaselineTransitions: 20,
        budgetBaselineWallClockMs: 90 * 60_000,
      }],
    });
    await persist(cwd, value, "run_id=budget-run\npid=202\n");
    const output = renderLoopStatus(cwd, "session-a", undefined, "verbose", { processAlive: () => false });
    assert.match(output, /tokens=50k/);
    assert.match(output, /baseline=5\.0m/);
    assert.match(output, /policy=convergence-v1/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default status bounds history while verbose mode exposes every retained run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-loop-status-history-"));
  try {
    const states = Array.from({ length: 12 }, (_, index) => state(`run-${index}`, {
      status: index < 3 ? "running" : "completed",
      sessionId: index === 0 ? "session-a" : "session-other",
      remainingIssues: index < 3 ? 1 : 0,
    }));
    for (const value of states) await persist(cwd, value, value.status === "running" ? `run_id=${value.runId}\npid=202\n` : undefined);
    const summary = renderLoopStatus(cwd, "session-a", undefined, "summary", { processAlive: () => false });
    const verbose = renderLoopStatus(cwd, "session-a", undefined, "verbose", { processAlive: () => false });
    assert.match(summary, /Current run: run-0/);
    assert.match(summary, /Historical: 9/);
    assert.ok(summary.length < verbose.length);
    assert.match(verbose, /run-11/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

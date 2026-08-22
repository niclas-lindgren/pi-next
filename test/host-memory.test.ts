import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  analyzeHostMemoryEnvelope,
  classifyHostMemoryPressure,
  hostMemoryNeedsRestart,
  hostMemoryFile,
  observeHostMemory,
} from "../extensions/pi-next/host-memory.ts";
import { createIssueLease, ensureIssueWorktree, type IssueLease, type IssueLeaseAuthority } from "../src/coordination/index.ts";
import { runLoopSteps } from "../extensions/pi-next/loop-controller.ts";
import { runOwnedIssueCycle } from "../extensions/pi-next/loop.ts";
import { createSupervisorRuntime } from "../extensions/pi-next/supervisor-runtime.ts";
import { emptyLoopMetrics, readLoopState, type LoopState } from "../extensions/pi-next/loop-state.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

const usage = (heapUsed: number, rss = heapUsed * 2) => ({
  heapUsed,
  heapTotal: heapUsed,
  rss,
  external: 10,
  arrayBuffers: 2,
});

test("host memory pressure classification is conservative and deterministic", () => {
  const policy = { highHeapRatio: 0.7, criticalHeapRatio: 0.9, criticalStreak: 2 };
  assert.equal(classifyHostMemoryPressure(600, 1_000, policy), "normal");
  assert.equal(classifyHostMemoryPressure(750, 1_000, policy), "high");
  assert.equal(classifyHostMemoryPressure(950, 1_000, policy), "critical");
  assert.equal(hostMemoryNeedsRestart("critical", 1, policy), false);
  assert.equal(hostMemoryNeedsRestart("critical", 2, policy), true);
});

test("forced-GC diagnostics are opt-in and expose retained settled growth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-gc-"));
  const runtime = globalThis as unknown as { gc?: () => void };
  const previousGc = runtime.gc;
  let gcCalls = 0;
  runtime.gc = () => { gcCalls += 1; };
  try {
    const samples = [];
    for (let index = 0; index < 51; index += 1) {
      const heapUsed = index === 25 ? 400 : 100 + Math.min(index, 50);
      samples.push(observeHostMemory(
        cwd,
        { boundary: "worker_end", runId: "gc-run", step: index },
        usage(heapUsed),
        1_000,
        {},
        { forceGc: true },
      ).sample);
    }
    const envelope = analyzeHostMemoryEnvelope(samples, 60);
    assert.equal(gcCalls, 51);
    assert.equal(envelope.retainedSampleCount, 51);
    assert.equal(envelope.settledGrowthBytes, 50);
    assert.equal(envelope.transientPeakBytes, 250);
    assert.equal(envelope.bounded, true);

    const leaking = samples.map((sample, index) => ({
      ...sample,
      retainedHeapUsed: 100 + index * 3,
    }));
    assert.equal(analyzeHostMemoryEnvelope(leaking, 60).bounded, false);
  } finally {
    if (previousGc === undefined) delete runtime.gc;
    else runtime.gc = previousGc;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repeated critical boundaries produce bounded, payload-free restart evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-"));
  try {
    const policy = { highHeapRatio: 0.7, criticalHeapRatio: 0.9, criticalStreak: 2 };
    const first = observeHostMemory(cwd, { boundary: "worker_end", runId: "run-1", issueNumber: 69, step: 1 }, usage(950), 1_000, policy);
    assert.equal(first.health.restartRequired, false);
    const second = observeHostMemory(cwd, { boundary: "before_session_transition", runId: "run-1", issueNumber: 69, step: 2 }, usage(960), 1_000, policy);
    assert.equal(second.health.restartRequired, true);
    assert.equal(second.health.samples.length, 2);
    assert.equal(second.sample.fromBaselineHeapUsed, 10);
    const persisted = JSON.parse(await readFile(hostMemoryFile(cwd), "utf8")) as Record<string, unknown>;
    assert.equal("prompt" in persisted, false);
    assert.equal("transcript" in persisted, false);
    assert.equal((persisted.samples as unknown[]).length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the real runLoopSteps boundary stops before another worker under host pressure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-host-pressure-controller-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  try {
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "--initial-branch=main", repo]);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "pi-next test");
    await writeFile(join(repo, "README.md"), "fixture\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "origin", "main");
    const workspace = await ensureIssueWorktree(repo, 69);
    await mkdir(join(workspace, ".pi-next"), { recursive: true });
    await writeFile(join(workspace, ".pi-next", "PLAN.md"), `# Plan: Issue #69\n\n**Goal:** bound parent memory\n\n**GitHub-Issue:** #69\n\n## Tasks\n\n- [ ] Add bounded host memory recovery\n  - Files: extensions/pi-next/host-memory.ts\n  - Approach: record payload-free samples and stop safely before another worker.\n\n## Acceptance Criteria\n\n- [ ] Host pressure stops before a new worker.\n\n## Log\n`);
    const now = new Date().toISOString();
    const state: LoopState = {
      version: 1,
      runId: "host-pressure-controller",
      sessionId: "host-pressure-session",
      requestedIssues: 1,
      remainingIssues: 1,
      step: 0,
      settledStep: 0,
      maxSteps: 10,
      completedIssues: [],
      deferredIssues: [],
      issueMetrics: [],
      status: "running",
      stopRequested: false,
      createdAt: now,
      updatedAt: now,
      metrics: emptyLoopMetrics(),
      coordinationCwd: repo,
      activeIssueNumber: 69,
      activeWorkspace: workspace,
      activeLease: {
        version: 1,
        issueNumber: 69,
        agent: "pi-next",
        runId: "host-pressure-controller",
        sessionId: "host-pressure-session",
        branch: "agent/issue-69",
        worktree: ".worktrees/issue-69",
        acquiredAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const previousCritical = process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO;
    const previousStreak = process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK;
    process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO = "0.0000001";
    process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK = "1";
    let launches = 0;
    try {
      await runLoopSteps(
        { cwd: workspace } as never,
        state,
        async () => { launches += 1; throw new Error("worker must not launch"); },
        createSupervisorRuntime(),
      );
    } finally {
      if (previousCritical === undefined) delete process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO;
      else process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO = previousCritical;
      if (previousStreak === undefined) delete process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK;
      else process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK = previousStreak;
    }
    const persisted = readLoopState(repo, state.runId);
    assert.equal(launches, 0);
    assert.equal(persisted?.status, "stopped");
    assert.equal(persisted?.hostMemory?.status, "restart_required");
    assert.match(persisted?.lastReason || "", /host_memory_pressure.*restart_required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-pressure stop preserves the active lease for restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-host-pressure-recovery-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  let released = false;
  try {
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "--initial-branch=main", repo]);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "pi-next test");
    await writeFile(join(repo, "README.md"), "fixture\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "origin", "main");
    const workspace = await ensureIssueWorktree(repo, 69);
    await mkdir(join(workspace, ".pi-next"), { recursive: true });
    await writeFile(join(workspace, ".pi-next", "PLAN.md"), `# Plan: Issue #69\n\n**Goal:** bound parent memory\n\n**GitHub-Issue:** #69\n\n## Tasks\n\n- [ ] Add bounded host memory recovery\n  - Files: extensions/pi-next/host-memory.ts\n  - Approach: stop safely before another worker.\n\n## Acceptance Criteria\n\n- [ ] Host pressure preserves recovery ownership.\n\n## Log\n`);
    const now = new Date().toISOString();
    const lease = createIssueLease({
      issueNumber: 69,
      agent: "pi-next",
      runId: "memory-recovery",
      sessionId: "memory-recovery-session",
      acquiredAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const authority: IssueLeaseAuthority = {
      read: async () => lease,
      create: async () => { throw new Error("unexpected create"); },
      replace: async () => { throw new Error("unexpected takeover"); },
      remove: async () => { released = true; },
    };
    const state: LoopState = {
      version: 1,
      runId: "memory-recovery",
      sessionId: "memory-recovery-session",
      requestedIssues: 1,
      remainingIssues: 1,
      step: 0,
      settledStep: 0,
      maxSteps: 10,
      completedIssues: [],
      deferredIssues: [],
      issueMetrics: [],
      status: "running",
      stopRequested: false,
      createdAt: now,
      updatedAt: now,
      metrics: emptyLoopMetrics(),
      coordinationCwd: repo,
      activeIssueNumber: 69,
      activeWorkspace: workspace,
      activeLease: lease,
    };
    const previousCritical = process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO;
    const previousStreak = process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK;
    process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO = "0.0000001";
    process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK = "2";
    try {
      const stopped = await runOwnedIssueCycle({ cwd: repo } as never, state, undefined, undefined, undefined, authority);
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.hostMemory?.status, "restart_required");
      assert.equal(released, false);
    } finally {
      if (previousCritical === undefined) delete process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO;
      else process.env.PI_NEXT_HOST_MEMORY_CRITICAL_RATIO = previousCritical;
      if (previousStreak === undefined) delete process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK;
      else process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK = previousStreak;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new run gets a new memory baseline instead of inheriting historical growth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-baseline-"));
  try {
    observeHostMemory(cwd, { boundary: "auto_start", runId: "run-1" }, usage(800), 1_000);
    const next = observeHostMemory(cwd, { boundary: "auto_start", runId: "run-2" }, usage(300), 1_000);
    assert.equal(next.sample.fromBaselineHeapUsed, 0);
    assert.equal(next.health.baselineHeapUsed, 300);
    assert.equal(next.health.criticalStreak, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

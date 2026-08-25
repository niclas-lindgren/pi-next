import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPiNextLoop } from "../extensions/pi-next/loop.ts";
import { emptyLoopMetrics, loopStateFile, readLoopState, type LoopState } from "../extensions/pi-next/loop-state.ts";
import { writeJsonAtomic } from "../extensions/pi-next/util.ts";
import { DEFAULT_PI_NEXT_CONFIG, type PiNextConfig } from "../src/coordination/config.ts";
import { __resetLiveCtxForTests } from "../extensions/pi-next/live-ctx.ts";
import { __resetRunCancellationForTests } from "../extensions/pi-next/run-cancellation.ts";

const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-loop-resume-"));
  await mkdir(join(root, ".pi-next"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--initial-branch=main", root]);
  await exec("git", ["-C", root, "config", "user.email", "resume@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "resume test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "baseline"]);
  // "memory" adapter with no seeded items: discovery finds no candidate and
  // the scheduler settles "idle" immediately, without ever touching a real
  // GitHub-backed authority/lease client, keeping this test deterministic
  // and network-free.
  const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as PiNextConfig;
  config.authority.adapter = "memory";
  await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(config));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function state(runId: string, overrides: Partial<LoopState> = {}): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    sessionId: "session-a",
    requestedIssues: 2,
    remainingIssues: 1,
    step: 0,
    settledStep: 0,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "cancelled",
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
    metrics: emptyLoopMetrics(),
    coordinationCwd: undefined,
    ...overrides,
  };
}

function context(cwd: string): { ctx: ExtensionCommandContext; notifications: Array<{ message: string; level: string }> } {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "session-a" },
    ui: {
      notify: (message: string, level: "info" | "warning" | "error") => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
    },
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

test("resume on unified-scheduler-produced ('cancelled') state routes through the shared scheduler, not ForegroundSupervisor", async () => {
  const f = await fixture();
  try {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    const runId = "run-cancelled-resume";
    writeJsonAtomic(loopStateFile(f.root, runId), state(runId));
    const { ctx, notifications } = context(f.root);

    await runPiNextLoop(`resume ${runId}`, ctx);

    // No rejection notification: the unified branch was taken.
    assert.ok(!notifications.some((entry) => /legacy pre-migration state/.test(entry.message)));
    const after = readLoopState(f.root, runId);
    // The shared scheduler discovered no candidates (empty in-memory
    // authority) and settled "idle" on its own, proving the run went through
    // runProductionLifecycleScheduler rather than being left untouched or
    // handed to a state machine that would set status back to "running".
    assert.equal(after?.status, "idle");
  } finally {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    await f.cleanup();
  }
});

test("resume on legacy pre-migration ('interrupted') state is rejected with actionable guidance, not launched", async () => {
  const f = await fixture();
  try {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    const runId = "run-interrupted-legacy";
    writeJsonAtomic(loopStateFile(f.root, runId), state(runId, { status: "interrupted" }));
    const { ctx, notifications } = context(f.root);

    await runPiNextLoop(`resume ${runId}`, ctx);

    assert.ok(notifications.some((entry) => /legacy pre-migration state/.test(entry.message) && entry.level === "warning"));
    const after = readLoopState(f.root, runId);
    // Rejected, not silently launched: the persisted state is untouched.
    assert.equal(after?.status, "interrupted");
  } finally {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    await f.cleanup();
  }
});

test("resume on legacy pre-migration ('stopped') state is rejected the same way", async () => {
  const f = await fixture();
  try {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    const runId = "run-stopped-legacy";
    writeJsonAtomic(loopStateFile(f.root, runId), state(runId, { status: "stopped" }));
    const { ctx, notifications } = context(f.root);

    await runPiNextLoop(`resume ${runId}`, ctx);

    assert.ok(notifications.some((entry) => /legacy pre-migration state/.test(entry.message) && entry.level === "warning"));
    const after = readLoopState(f.root, runId);
    assert.equal(after?.status, "stopped");
  } finally {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    await f.cleanup();
  }
});

test("resume declines a run with no remaining issues regardless of shape", async () => {
  const f = await fixture();
  try {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    const runId = "run-settled";
    writeJsonAtomic(loopStateFile(f.root, runId), state(runId, { remainingIssues: 0 }));
    const { ctx, notifications } = context(f.root);

    await runPiNextLoop(`resume ${runId}`, ctx);

    assert.ok(notifications.some((entry) => /No interrupted, stopped, or cancelled/.test(entry.message)));
  } finally {
    __resetLiveCtxForTests();
    __resetRunCancellationForTests();
    await f.cleanup();
  }
});

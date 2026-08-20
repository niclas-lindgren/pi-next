import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  activeAutoStatusRun,
  clearAutoStatus,
  registerPiNextCommands,
  startAutoStatusHeartbeat,
} from "../extensions/pi-next/commands-recovery.ts";
import { type LoopState } from "../extensions/pi-next/loop-state.ts";
import { currentSupervisorStatus, formatSupervisorStatus } from "../extensions/pi-next/foreground-supervisor.ts";

function state(runId: string, updatedAt: string, overrides: Partial<LoopState> = {}): LoopState {
  return {
    version: 1,
    runId,
    requestedIssues: 2,
    remainingIssues: 2,
    step: 1,
    settledStep: 0,
    maxSteps: 40,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: updatedAt,
    updatedAt,
    metrics: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      sessions: 0,
      prompts: 0,
      modelDurationMs: 0,
      telemetryUnavailable: 0,
    },
    sessionId: "session-a",
    ...overrides,
  };
}

function context(cwd: string, statuses: Array<[string, string | undefined]>, sessionId = "session-a"): ExtensionCommandContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    },
  } as unknown as ExtensionCommandContext;
}

test("auto footer updates in place and preserves a terminal status", async () => {
  const cwd = await mkdtemp(join("/tmp", "pi-next-auto-status-"));
  const runId = "run-status";
  const runDir = join(cwd, ".pi", "runtime", "pi-next-loops", runId);
  await mkdir(runDir, { recursive: true });
  const initial = state(runId, "2026-01-01T00:00:00.000Z", { activeIssueNumber: 32 });
  await writeFile(join(runDir, "state.json"), JSON.stringify(initial));
  await writeFile(join(runDir, "controller.lock"), `run_id=${runId}\npid=${process.pid}\n`);

  const statuses: Array<[string, string | undefined]> = [];
  const ctx = context(cwd, statuses);
  const stop = startAutoStatusHeartbeat(ctx, () => runId);
  try {
    assert.equal(statuses[0]?.[0], "pi-next-auto");
    assert.match(statuses[0]?.[1] || "", /#32/);

    // Exercise the real timer boundary rather than only the renderer. The
    // repeated write must use the same controller-owned status key.
    await new Promise((resolve) => setTimeout(resolve, 2_550));
    assert.ok(statuses.length >= 2);
    assert.ok(statuses.every(([key]: [string, string | undefined]) => key === "pi-next-auto"));

    const terminal = state(runId, "2026-01-01T00:00:01.000Z", {
      status: "blocked",
      remainingIssues: 1,
      activeIssueNumber: 32,
      lastReason: "foreign or malformed workflow artifact",
    });
    await writeFile(join(runDir, "state.json"), JSON.stringify(terminal));
    stop();

    const final = statuses.at(-1)?.[1] || "";
    assert.match(final, /blocked/);
    assert.match(final, /workspace authority conflict/);
    assert.ok(statuses.every(([, text]: [string, string | undefined]) => text !== undefined), "ordinary completion must not clear status");

    const completed = state(runId, "2026-01-01T00:00:02.000Z", {
      status: "completed",
      remainingIssues: 0,
      completedIssues: [32, 33],
    });
    await writeFile(join(runDir, "state.json"), JSON.stringify(completed));
    const stopCompleted = startAutoStatusHeartbeat(ctx, () => runId);
    stopCompleted();
    assert.match(statuses.at(-1)?.[1] || "", /complete/);
  } finally {
    // stop is idempotent and also protects the test process from a leaked timer.
    stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a new auto run replaces an older terminal footer immediately", async () => {
  const cwd = await mkdtemp(join("/tmp", "pi-next-auto-status-replace-"));
  try {
    const old = state("old-terminal", "2026-01-01T00:00:00.000Z", {
      status: "completed",
      remainingIssues: 0,
    });
    const dir = join(cwd, ".pi", "runtime", "pi-next-loops", old.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify(old));
    const statuses: Array<[string, string | undefined]> = [];
    const stop = startAutoStatusHeartbeat(
      context(cwd, statuses),
      () => undefined,
      { replaceExisting: true },
    );
    try {
      assert.match(statuses[0]?.[1] || "", /no issue attached/);
      assert.doesNotMatch(statuses[0]?.[1] || "", /complete/);
    } finally {
      stop();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal durable state fences stale worker liveness", async () => {
  const cwd = await mkdtemp(join("/tmp", "pi-next-auto-status-terminal-"));
  try {
    const runId = "terminal-run";
    const dir = join(cwd, ".pi", "runtime", "pi-next-loops", runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify(state(runId, "2026-01-01T00:00:00.000Z", {
      status: "interrupted",
      lastReason: "worker exited",
      activeIssueNumber: 32,
    })));
    const status = currentSupervisorStatus(cwd, runId);
    assert.equal(status?.phase, "aborted");
    assert.equal(status?.workerLiveness, "not-running");
    assert.doesNotMatch(formatSupervisorStatus(status!), /worker alive/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("independent session status never falls back to another session's newer run", async () => {
  const cwd = await mkdtemp(join("/tmp", "pi-next-auto-status-order-"));
  try {
    for (const current of [
      state("old-run", "2026-01-01T00:00:00.000Z", { sessionId: "session-a" }),
      state("new-run", "2026-01-01T00:00:01.000Z", { status: "completed", remainingIssues: 0, sessionId: "session-b" }),
    ]) {
      const dir = join(cwd, ".pi", "runtime", "pi-next-loops", current.runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "state.json"), JSON.stringify(current));
    }
    assert.equal(activeAutoStatusRun(cwd, undefined, "session-a")?.runId, "old-run");
    assert.equal(activeAutoStatusRun(cwd, undefined, "session-b")?.runId, "new-run");
    assert.equal(activeAutoStatusRun(cwd)?.runId, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session replacement rebinds durable status and shutdown only cancels old writes", async () => {
  const cwd = await mkdtemp(join("/tmp", "pi-next-auto-status-session-"));
  try {
    const runId = "replacement-run";
    const runDir = join(cwd, ".pi", "runtime", "pi-next-loops", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "state.json"), JSON.stringify(state(runId, "2026-01-01T00:00:00.000Z", {
      status: "blocked",
      activeIssueNumber: 32,
      lastReason: "ownership conflict",
    })));

    const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
    const pi = {
      registerCommand: () => undefined,
      on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => events.set(name, handler),
    } as unknown as ExtensionAPI;
    registerPiNextCommands(pi);

    const statuses: Array<[string, string | undefined]> = [];
    events.get("session_start")?.({}, context(cwd, statuses, "session-a"));
    assert.match(statuses.at(-1)?.[1] || "", /blocked/);

    // A live state gets a replacement heartbeat, but shutdown must cancel it
    // without attempting to clear or write through the old context.
    await writeFile(join(runDir, "state.json"), JSON.stringify(state(runId, "2026-01-01T00:00:01.000Z")));
    await writeFile(join(runDir, "controller.lock"), `run_id=${runId}\npid=${process.pid}\n`);
    const liveStatuses: Array<[string, string | undefined]> = [];
    const liveCtx = context(cwd, liveStatuses, "session-a");
    events.get("session_start")?.({}, liveCtx);
    const beforeShutdown = liveStatuses.length;
    events.get("session_shutdown")?.({}, liveCtx);
    assert.equal(liveStatuses.length, beforeShutdown);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("clear is an explicit footer lifecycle operation", () => {
  const statuses: Array<[string, string | undefined]> = [];
  clearAutoStatus(context("/tmp", statuses));
  assert.deepEqual(statuses, [["pi-next-auto", undefined]]);
});

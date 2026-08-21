import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createIssueLease,
  issueWorkspaceIdentity,
  reconcileIssueLeaseForResume,
  LeaseConflictError,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";
import {
  prepareAbandonedAutoResume,
  recoverableAbandonedAutoRun,
  registerPiNextCommands,
} from "../extensions/pi-next/commands-recovery.ts";
import { ForegroundSupervisor } from "../extensions/pi-next/foreground-supervisor.ts";
import { lifecycleTelemetryFile, recordLifecycleEvent } from "../extensions/pi-next/lifecycle-telemetry.ts";
import { emptyLoopMetrics, loopStateFile, type LoopState } from "../extensions/pi-next/loop-state.ts";

class MemoryAuthority implements IssueLeaseAuthority {
  constructor(private current?: IssueLease) {}

  async read(): Promise<IssueLease | undefined> {
    return this.current;
  }

  async create(_issueNumber: number, lease: IssueLease): Promise<void> {
    if (this.current) throw new Error("compare-and-swap failed");
    this.current = lease;
  }

  async replace(_issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    if (this.current !== expected) throw new Error("compare-and-swap failed");
    this.current = lease;
  }

  async remove(): Promise<void> {
    this.current = undefined;
  }

  value(): IssueLease | undefined {
    return this.current;
  }
}

function lease(overrides: Partial<IssueLease> = {}): IssueLease {
  const identity = issueWorkspaceIdentity(7);
  return {
    version: 1,
    issueNumber: 7,
    agent: "pi-next",
    runId: "abandoned-run",
    sessionId: "abandoned-session",
    branch: identity.branch,
    worktree: identity.worktree,
    acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    ...overrides,
  };
}

function abandonedState(cwd: string, activeLease: IssueLease): LoopState {
  return {
    version: 1,
    runId: activeLease.runId,
    sessionId: activeLease.sessionId,
    requestedIssues: 1,
    remainingIssues: 1,
    step: 1,
    settledStep: 1,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "interrupted",
    stopRequested: false,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: cwd,
    activeIssueNumber: 7,
    activeWorkspace: resolve(cwd, activeLease.worktree),
    activeLease,
  };
}

async function persistState(cwd: string, state: LoopState): Promise<void> {
  await mkdir(join(cwd, ".pi", "runtime", "pi-next-loops", state.runId), { recursive: true });
  await writeFile(loopStateFile(cwd, state.runId), JSON.stringify(state));
}

test("abandoned discovery admits a matching stale lease but rejects foreign or missing authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-abandoned-recovery-"));
  try {
    const stale = lease();
    await persistState(cwd, abandonedState(cwd, stale));

    const recovered = await recoverableAbandonedAutoRun(cwd, new MemoryAuthority(stale));
    assert.equal(recovered?.runId, stale.runId);
    assert.equal(recovered?.activeIssueNumber, stale.issueNumber);

    const foreign = await recoverableAbandonedAutoRun(
      cwd,
      new MemoryAuthority(lease({ runId: "other-run", sessionId: "other-session" })),
    );
    assert.equal(foreign, undefined);
    assert.equal(await recoverableAbandonedAutoRun(cwd, new MemoryAuthority()), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("abandoned preparation preserves dirty canonical work across stale recovery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-dirty-recovery-"));
  try {
    const stale = lease();
    const workspace = resolve(cwd, stale.worktree);
    await mkdir(workspace, { recursive: true });
    execFileSync("git", ["-C", workspace, "init", "-q"]);
    execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "pi-next test"]);
    await writeFile(join(workspace, "baseline.txt"), "baseline\\n");
    execFileSync("git", ["-C", workspace, "add", "baseline.txt"]);
    execFileSync("git", ["-C", workspace, "commit", "-qm", "baseline"]);
    await writeFile(join(workspace, "unfinished.txt"), "keep me\\n");

    const state = { ...abandonedState(cwd, stale), step: 2, settledStep: 1 };
    await persistState(cwd, state);
    const prepared = await prepareAbandonedAutoResume(cwd, state, "replacement-session");

    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.dirtyFiles, ["unfinished.txt"]);
    assert.equal(await readFile(join(workspace, "unfinished.txt"), "utf8"), "keep me\\n");
    assert.equal(JSON.parse(await readFile(loopStateFile(cwd, stale.runId), "utf8")).status, "running");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto recovery gates the normal command before candidate selection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-recovery-order-"));
  const calls: string[] = [];
  const handlers = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      handlers.set(name, command);
    },
  };
  const original = ForegroundSupervisor.recoverOnStart;
  (ForegroundSupervisor as unknown as {
    recoverOnStart: (ctx: unknown) => Promise<{ recovered: boolean; runId?: string; issueNumber?: number }>;
  }).recoverOnStart = async () => {
    calls.push("recovery");
    return { recovered: true, runId: "abandoned-run", issueNumber: 7 };
  };
  try {
    registerPiNextCommands(pi as never);
    const command = handlers.get("pi-next");
    assert.ok(command);
    await command.handler("auto", {
      cwd,
      sessionManager: { getSessionId: () => "session-restart" },
      ui: { setStatus: () => undefined, notify: () => undefined },
    });
    assert.deepEqual(calls, ["recovery"]);
  } finally {
    (ForegroundSupervisor as unknown as { recoverOnStart: typeof original }).recoverOnStart = original;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stale recovery uses CAS takeover and records recovered claim telemetry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-stale-lease-"));
  try {
    const stale = lease();
    const authority = new MemoryAuthority(stale);
    const recovered = await reconcileIssueLeaseForResume(
      authority,
      stale,
      new Date(),
      { cwd, recordEvent: recordLifecycleEvent },
    );
    assert.equal(recovered.runId, stale.runId);
    assert.ok(Date.parse(recovered.expiresAt) > Date.now());
    assert.notEqual(authority.value(), stale);

    const telemetry = JSON.parse(await readFile(lifecycleTelemetryFile(cwd), "utf8")) as { events: Array<{ event: string; outcome: string; at?: string }> };
    assert.deepEqual(telemetry.events.at(-1), {
      event: "claim_taken_over",
      issueNumber: 7,
      runId: stale.runId,
      agent: "pi-next",
      branch: stale.branch,
      worktree: stale.worktree,
      outcome: "recovered",
      at: telemetry.events.at(-1)?.at,
    });

    await assert.rejects(
      () => reconcileIssueLeaseForResume(
        new MemoryAuthority(lease({ runId: "foreign-run", sessionId: "foreign-session" })),
        stale,
      ),
      LeaseConflictError,
      "stale foreign ownership must not be reclaimed from local durable state",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

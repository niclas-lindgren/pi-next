import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  issueWorkspaceIdentity,
  reconcileIssueLeaseForResume,
  LeaseConflictError,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";
import { recoverableAbandonedAutoRun } from "../extensions/pi-next/commands-recovery.ts";
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

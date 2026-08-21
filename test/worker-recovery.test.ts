import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { issueWorkspaceIdentity, type IssueLease } from "../extensions/pi-next/issue-authority.ts";
import { reconcileMissingLoopResult } from "../extensions/pi-next/loop-controller.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function state(root: string, workspace: string, lease: IssueLease): LoopState {
  return {
    version: 1,
    runId: lease.runId,
    requestedIssues: 1,
    remainingIssues: 1,
    step: 1,
    settledStep: 0,
    maxSteps: 20,
    stepHead: "baseline",
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "interrupted",
    stopRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: root,
    activeIssueNumber: lease.issueNumber,
    activeWorkspace: workspace,
    activeLease: lease,
    workerResultMissing: true,
    lastReason: "Worker exited without pi_next_update(action=loop_result): transient process failure",
  };
}

test("missing loop_result preserves dirty issue work and resumes the same issue with bounded retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-worker-recovery-"));
  try {
    const identity = issueWorkspaceIdentity(7);
    const workspace = join(root, identity.worktree);
    await mkdir(workspace, { recursive: true });
    git(workspace, "init", "-q");
    git(workspace, "switch", "-c", identity.branch);
    git(workspace, "config", "user.email", "test@example.invalid");
    git(workspace, "config", "user.name", "pi-next test");
    await writeFile(join(workspace, "tracked.txt"), "partial work\n");
    git(workspace, "add", "tracked.txt");
    git(workspace, "commit", "-qm", "baseline");
    await writeFile(join(workspace, "partial.ts"), "unfinished\n");

    const lease: IssueLease = {
      version: 1,
      issueNumber: 7,
      branch: identity.branch,
      worktree: identity.worktree,
      agent: "pi-next",
      runId: "recovery-run",
      sessionId: "recovery-session",
      acquiredAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const authority = { read: async () => lease };
    const activity: string[] = [];
    const first = await reconcileMissingLoopResult(
      root,
      state(root, workspace, lease),
      authority,
      { maxAttempts: 1, onActivity: (summary) => activity.push(summary) },
    );

    assert.equal(first.outcome, "resuming_same_issue");
    assert.deepEqual(activity, [
      "reconciling missing worker result · attempt 1/1",
      "validating canonical worktree",
      "reading authoritative issue lease",
      "authoritative issue lease confirmed",
      "checking repository state",
      "repository state is recoverable; preserving issue-local changes",
      "inspecting durable recovery evidence",
      "no durable completion evidence; preparing same-issue resume",
    ]);
    assert.equal(first.state.status, "running");
    assert.equal(first.state.activeIssueNumber, 7);
    assert.equal(first.state.settledStep, 1);
    assert.equal(await readFile(join(workspace, "partial.ts"), "utf8"), "unfinished\n");

    let transientReads = 0;
    const transientAuthority = {
      read: async () => {
        transientReads += 1;
        if (transientReads === 1) {
          const error = new Error("temporary network timeout");
          Object.assign(error, { code: "ETIMEDOUT" });
          throw error;
        }
        return lease;
      },
    };
    const transientActivity: string[] = [];
    const transient = await reconcileMissingLoopResult(
      root,
      state(root, workspace, lease),
      transientAuthority,
      { maxAttempts: 3, onActivity: (summary) => transientActivity.push(summary) },
    );
    assert.equal(transient.outcome, "resuming_same_issue");
    assert.equal(transientReads, 2, "transient authority failures are retried before blocking");
    assert.ok(transientActivity.includes("authority read transient · retry 1/3"));
    assert.ok(transientActivity.includes("retrying authoritative lease read · attempt 2/3"));
    const transientFingerprint = transient.state.recovery?.lastFingerprint;
    assert.equal(
      transient.state.recovery?.attemptsByFingerprint[transientFingerprint || ""],
      1,
    );

    const repeatedTransient = await reconcileMissingLoopResult(
      root,
      {
        ...transient.state,
        status: "interrupted",
        step: 1,
        settledStep: 0,
        workerResultMissing: true,
      },
      { read: async () => {
        const error = new Error("temporary network timeout");
        Object.assign(error, { code: "ETIMEDOUT" });
        throw error;
      } },
      { maxAttempts: 2 },
    );
    assert.equal(repeatedTransient.outcome, "recovery_exhausted");
    assert.equal(repeatedTransient.state.status, "blocked");
    assert.equal(
      repeatedTransient.state.recovery?.attemptsByFingerprint[transientFingerprint || ""],
      2,
    );

    const foreign = await reconcileMissingLoopResult(
      root,
      state(root, workspace, lease),
      { read: async () => undefined },
      { maxAttempts: 3 },
    );
    assert.equal(foreign.outcome, "recovery_unsafe");
    assert.equal(foreign.state.recovery?.attemptsByFingerprint[foreign.fingerprint || ""], undefined);

    let staleReads = 0;
    const stale = await reconcileMissingLoopResult(
      root,
      state(root, workspace, lease),
      { read: async () => {
        staleReads += 1;
        return { ...lease, expiresAt: new Date(Date.now() - 1_000).toISOString() };
      } },
      { maxAttempts: 3 },
    );
    assert.equal(stale.outcome, "recovery_unsafe");
    assert.equal(staleReads, 1, "a stale lease is a proven ownership failure, not a transient retry");

    const repeated: LoopState = {
      ...first.state,
      step: 2,
      settledStep: 1,
      status: "interrupted",
      workerResultMissing: true,
      lastReason: state(root, workspace, lease).lastReason,
    };
    const exhausted = await reconcileMissingLoopResult(root, repeated, authority, { maxAttempts: 1 });
    assert.equal(exhausted.outcome, "recovery_exhausted");
    assert.equal(exhausted.state.status, "blocked");
    assert.equal(exhausted.state.activeIssueNumber, 7);
    assert.equal(await readFile(join(workspace, "partial.ts"), "utf8"), "unfinished\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

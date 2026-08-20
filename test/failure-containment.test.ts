import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createIssueLease, issueWorkspaceIdentity, type IssueLease, type IssueLeaseAuthority } from "../src/coordination/index.ts";
import { classifyFailure } from "../extensions/pi-next/failure-scope.ts";
import { containIssueLocalFailure } from "../extensions/pi-next/loop.ts";
import { PlanAuthorityError } from "../extensions/pi-next/util-core.ts";
import { emptyLoopMetrics, loopStateFile, readLoopState, type LoopState } from "../extensions/pi-next/loop-state.ts";

class MemoryAuthority implements IssueLeaseAuthority {
  removed = false;
  constructor(private lease: IssueLease) {}
  async read() { return this.removed ? undefined : this.lease; }
  async create() { throw new Error("not used"); }
  async replace() { throw new Error("not used"); }
  async remove(_issue: number, expected: IssueLease) {
    assert.equal(expected.runId, this.lease.runId);
    this.removed = true;
  }
}

function state(root: string, workspace: string, lease: IssueLease): LoopState {
  return {
    version: 1,
    runId: "containment-run",
    requestedIssues: 2,
    remainingIssues: 2,
    step: 1,
    settledStep: 1,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: root,
    activeIssueNumber: lease.issueNumber,
    activeWorkspace: workspace,
    activeLease: lease,
  };
}

test("issue-local plan authority failure is contained without deleting the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-containment-"));
  try {
    const identity = issueWorkspaceIdentity(609);
    const workspace = resolve(root, identity.worktree);
    await mkdir(join(workspace, ".pi-next"), { recursive: true });
    const planPath = join(workspace, ".pi-next", "PLAN.md");
    await writeFile(planPath, "foreign or malformed plan\n");
    const lease = createIssueLease({
      issueNumber: 609,
      agent: "pi-next",
      runId: "containment-run",
      sessionId: "containment-session",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const initial = state(root, workspace, lease);
    const failure = new PlanAuthorityError("unowned", "foreign workflow artifact", [planPath]);
    const classification = classifyFailure(failure, {
      stage: "workspace-validation",
      issueNumber: 609,
      workspace,
      coordinationCwd: root,
      ownershipProven: true,
    });
    const authority = new MemoryAuthority(lease);
    const contained = await containIssueLocalFailure(root, initial, classification, { authority, lease });

    assert.equal(authority.removed, true);
    assert.equal(contained.status, "running");
    assert.equal(contained.remainingIssues, 1);
    assert.deepEqual(contained.deferredIssues.map((item) => item.issueNumber), [609]);
    assert.equal(contained.deferredIssues[0].kind, "blocked");
    assert.equal(contained.activeIssueNumber, undefined);
    assert.equal(await readFile(planPath, "utf8"), "foreign or malformed plan\n");
    assert.equal(readLoopState(root, initial.runId)?.remainingIssues, 1);
    assert.match(readLoopState(root, initial.runId)?.lastReason || "", /#609 blocked/);
    assert.equal(await readFile(loopStateFile(root, initial.runId), "utf8").then((text) => text.includes('"activeLease"')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unproven lease ownership is classified globally and cannot be contained", () => {
  const classification = classifyFailure(
    new PlanAuthorityError("unowned", "partial state"),
    { stage: "claim", issueNumber: 609, ownershipProven: false },
  );
  assert.equal(classification.scope, "loop-global");
});

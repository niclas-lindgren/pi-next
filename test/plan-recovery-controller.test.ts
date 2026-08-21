import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { runOneStep } from "../extensions/pi-next/loop-controller.ts";
import { createSupervisorRuntime } from "../extensions/pi-next/supervisor-runtime.ts";
import {
  emptyLoopMetrics,
  readLoopState,
  writeLoopResult,
  type LoopState,
} from "../extensions/pi-next/loop-state.ts";
import { primeIssueFreshness } from "../extensions/pi-next/issue-freshness.ts";
import type { IssueWorkerRunner } from "../extensions/pi-next/util-core.ts";
import { ensureIssueWorktree } from "../src/coordination/index.ts";

const exec = promisify(execFile);

const INVALID_PLAN = `# Plan: Issue #67

**Goal:** repair task metadata without changing product requirements

**GitHub-Issue:** #67

## Tasks

- [ ] Repair the owned task metadata
  - Existing completed work remains intact.

## Acceptance Criteria

- [ ] The planning worker repairs only PLAN metadata.

## Log
- Existing progress is preserved.
`;

const VALID_PLAN = INVALID_PLAN.replace(
  "  - Existing completed work remains intact.",
  "  - Files: extensions/pi-next/loop-controller.ts, test/plan-recovery-controller.test.ts\n  - Approach: update only the owned PLAN metadata and preserve all existing requirements.",
);

function state(coordinationCwd: string, workspace: string): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: "plan-repair-controller",
    sessionId: "plan-repair-session",
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
    coordinationCwd,
    activeIssueNumber: 67,
    activeWorkspace: workspace,
    activeLease: {
      version: 1,
      issueNumber: 67,
      agent: "pi-next",
      runId: "plan-repair-controller",
      sessionId: "plan-repair-session",
      branch: "agent/issue-67",
      worktree: ".worktrees/issue-67",
      acquiredAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    planRepair: {
      attempts: 2,
      maxAttempts: 2,
      fingerprint: "task-metadata:files=0;approaches=1",
      lastErrors: ["Task missing Approach: an earlier task"],
      updatedAt: now,
    },
  };
}

test("real PLAN repair dispatch persists state, resets changed fingerprints, and stays planning-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-plan-repair-controller-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const fakeGh = join(bin, "gh");
  const previousPath = process.env.PATH;
  let workspace: string | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(repo, "README.md"), "fixture\n");
    await writeFile(join(repo, ".gitignore"), ".pi/\n");
    await exec("git", ["-C", repo, "init", "--initial-branch=main"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", repo, "config", "user.name", "pi-next test"]);
    await exec("git", ["-C", repo, "add", "README.md", ".gitignore"]);
    await exec("git", ["-C", repo, "commit", "-m", "fixture"]);
    workspace = await ensureIssueWorktree(repo, 67);
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  number: 67,
  title: "PLAN repair fixture",
  body: "## Acceptance Criteria\\n- [ ] The planning worker repairs only PLAN metadata.",
  state: "OPEN",
  updatedAt: "2026-08-21T14:32:48Z",
  labels: [{ name: "status:ready" }, { name: "priority: P1" }],
  comments: []
}));
`,
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${bin}:${previousPath || ""}`;
    await mkdir(join(workspace, ".pi-next"), { recursive: true });
    await writeFile(join(workspace, ".pi-next", "PLAN.md"), INVALID_PLAN);
    await primeIssueFreshness(workspace, 67);

    const initial = state(repo, workspace);
    const phases: string[] = [];
    const roles: string[] = [];
    let calls = 0;
    const worker: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
      calls += 1;
      phases.push(options.phase || "");
      roles.push(options.dispatch?.role || "");
      await exec("git", ["-C", _cwd, "add", ".pi-next/PLAN.md"]);
      await exec("git", ["-C", _cwd, "commit", "-m", `repair worker step ${calls}`]);
      writeLoopResult(repo, {
        runId: options.runId || initial.runId,
        step: calls,
        outcome: "continue",
        writtenAt: new Date().toISOString(),
      });
      return {
        ok: true,
        output: "",
        code: 0,
        signal: null,
        telemetry: { status: "unavailable" },
      };
    };

    const first = await runOneStep(
      { cwd: workspace } as unknown as ExtensionCommandContext,
      initial,
      1,
      worker,
      createSupervisorRuntime(),
    );
    assert.equal(calls, 1);
    assert.deepEqual(phases, ["planning"]);
    assert.deepEqual(roles, ["planning"]);
    assert.equal(first.terminal, false);
    const firstDurable = readLoopState(repo, initial.runId);
    assert.equal(firstDurable?.planRepair?.attempts, 1);
    assert.equal(firstDurable?.planRepair?.fingerprint, "task-metadata:files=1;approaches=1");
    assert.equal(await readFile(join(workspace, ".pi-next", "PLAN.md"), "utf8"), INVALID_PLAN);

    await writeFile(join(workspace, ".pi-next", "PLAN.md"), VALID_PLAN);
    const second = await runOneStep(
      { cwd: workspace } as unknown as ExtensionCommandContext,
      first.state,
      2,
      worker,
      createSupervisorRuntime(),
    );
    assert.equal(calls, 2);
    assert.deepEqual(phases, ["planning", "implementation"]);
    assert.equal(second.terminal, false);
    const secondDurable = readLoopState(repo, initial.runId);
    assert.equal(secondDurable?.planRepair, undefined);
    assert.equal(secondDurable?.step, 2);
    assert.equal(await readFile(join(workspace, ".pi-next", "PLAN.md"), "utf8"), VALID_PLAN);
  } finally {
    process.env.PATH = previousPath;
    if (workspace) await exec("git", ["-C", repo, "worktree", "remove", "--force", workspace]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { runLoopSteps, runOneStep } from "../extensions/pi-next/loop-controller.ts";
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
import { IssueBoundaryFailure } from "../extensions/pi-next/failure-scope.ts";

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

/** Campsty #641 shape: three named tasks, each missing both Files/Approach. */
const CAMPSTY_641_SHAPE_PLAN = `# Plan: Issue #67

**Goal:** separate marketing-root rendering from authenticated workspace resolution

**GitHub-Issue:** #67

## Tasks

- [ ] Separate marketing-root rendering from authenticated workspace resolution
  - Repository inspection is required to name the exact modules.
- [ ] Move default post-auth entry to the resolver route while preserving intent
  - Repository inspection is required to name the exact modules.
- [ ] Audit authenticated navigation and lock the two responsibilities apart
  - Repository inspection is required to name the exact modules.

## Acceptance Criteria

- [ ] Marketing-root rendering and authenticated workspace resolution are separated.

## Log
`;

async function setupRepairFixture(): Promise<{
  root: string;
  repo: string;
  workspace: string;
  previousPath: string | undefined;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-next-plan-repair-controller-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const fakeGh = join(bin, "gh");
  const previousPath = process.env.PATH;
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await writeFile(join(repo, ".gitignore"), ".pi/\n");
  await exec("git", ["-C", repo, "init", "--initial-branch=main"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "pi-next test"]);
  await exec("git", ["-C", repo, "add", "README.md", ".gitignore"]);
  await exec("git", ["-C", repo, "commit", "-m", "fixture"]);
  const workspace = await ensureIssueWorktree(repo, 67);
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
  await primeIssueFreshness(workspace, 67);
  return { root, repo, workspace, previousPath };
}

async function teardownRepairFixture(fixture: {
  root: string;
  repo: string;
  workspace: string;
  previousPath: string | undefined;
}): Promise<void> {
  process.env.PATH = fixture.previousPath;
  await exec("git", ["-C", fixture.repo, "worktree", "remove", "--force", fixture.workspace]).catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
}

test("Campsty #641 shape with three valid task names does not immediately contain before a repair opportunity", async () => {
  const fixture = await setupRepairFixture();
  try {
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), CAMPSTY_641_SHAPE_PLAN);
    const initial = state(fixture.repo, fixture.workspace);
    const worker: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
      writeLoopResult(fixture.repo, {
        runId: options.runId || initial.runId,
        step: 1,
        outcome: "continue",
        writtenAt: new Date().toISOString(),
      });
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    const result = await runOneStep(
      { cwd: fixture.workspace } as unknown as ExtensionCommandContext,
      initial,
      1,
      worker,
      createSupervisorRuntime(),
    );
    // A repair opportunity was granted (planning-only dispatch), not immediate containment.
    assert.equal(result.terminal, false);
    const durable = readLoopState(fixture.repo, initial.runId);
    assert.equal(durable?.planRepair?.attempts, 1);
    assert.equal(durable?.planRepair?.fingerprint, "task-metadata:files=3;approaches=3");
  } finally {
    await teardownRepairFixture(fixture);
  }
});

test("the outer runLoopSteps preflight reaches planning repair before bounded containment", async () => {
  const fixture = await setupRepairFixture();
  try {
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), CAMPSTY_641_SHAPE_PLAN);
    const initial = state(fixture.repo, fixture.workspace);
    let calls = 0;
    const worker: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
      calls += 1;
      writeLoopResult(fixture.repo, {
        runId: options.runId || initial.runId,
        step: calls,
        outcome: "continue",
        writtenAt: new Date().toISOString(),
      });
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    const context = {
      cwd: fixture.workspace,
      hasUI: false,
      newSession: async ({ withSession }: { withSession: (next: unknown) => Promise<void> }) =>
        withSession(context),
    } as unknown as ExtensionCommandContext;
    await assert.rejects(
      () => runLoopSteps(context, initial, worker, createSupervisorRuntime()),
      (error: unknown) =>
        error instanceof IssueBoundaryFailure &&
        /repair exhausted after 2 bounded attempts/.test(error.reason),
    );
    // The outer preflight did not contain before the first planning worker.
    assert.equal(calls, 2);
    const durable = readLoopState(fixture.repo, initial.runId);
    assert.equal(durable?.planRepair?.attempts, 2);
    assert.equal(durable?.planRepair?.fingerprint, "task-metadata:files=3;approaches=3");
  } finally {
    await teardownRepairFixture(fixture);
  }
});

test("completed task checkboxes and log entries survive a repair cycle", async () => {
  const fixture = await setupRepairFixture();
  try {
    const planWithProgress = `# Plan: Issue #67

**Goal:** repair task metadata without changing product requirements

**GitHub-Issue:** #67

## Tasks

- [x] Already completed prerequisite task
  - Files: extensions/pi-next/loop-controller.ts
  - Approach: already implemented and committed.
- [ ] Repair the owned task metadata
  - Missing metadata that requires repository inspection.

## Acceptance Criteria

- [ ] The planning worker repairs only PLAN metadata.

## Log
- 2026-08-20: Completed the prerequisite task.
`;
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), planWithProgress);
    const initial = state(fixture.repo, fixture.workspace);
    const worker: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
      const repaired = planWithProgress.replace(
        "  - Missing metadata that requires repository inspection.",
        "  - Files: extensions/pi-next/execution-boundary.ts\n  - Approach: repair only the owned PLAN metadata.",
      );
      await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), repaired);
      await exec("git", ["-C", fixture.workspace, "add", ".pi-next/PLAN.md"]);
      await exec("git", ["-C", fixture.workspace, "commit", "-m", "repair PLAN metadata"]);
      writeLoopResult(fixture.repo, {
        runId: options.runId || initial.runId,
        step: 1,
        outcome: "continue",
        writtenAt: new Date().toISOString(),
      });
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    await runOneStep(
      { cwd: fixture.workspace } as unknown as ExtensionCommandContext,
      initial,
      1,
      worker,
      createSupervisorRuntime(),
    );
    const finalPlan = await readFile(join(fixture.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.match(finalPlan, /- \[x\] Already completed prerequisite task/);
    assert.match(finalPlan, /Completed the prerequisite task\./);
  } finally {
    await teardownRepairFixture(fixture);
  }
});

test("dirty issue-local work survives a repair cycle", async () => {
  const fixture = await setupRepairFixture();
  try {
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), CAMPSTY_641_SHAPE_PLAN);
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(join(fixture.workspace, "src", "wip.ts"), "export const wip = true;\n");
    const initial = state(fixture.repo, fixture.workspace);
    const worker: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
      writeLoopResult(fixture.repo, {
        runId: options.runId || initial.runId,
        step: 1,
        outcome: "continue",
        writtenAt: new Date().toISOString(),
      });
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    await runOneStep(
      { cwd: fixture.workspace } as unknown as ExtensionCommandContext,
      initial,
      1,
      worker,
      createSupervisorRuntime(),
    );
    // The dirty, uncommitted issue-local file must not be reset/stashed/deleted.
    assert.equal(await readFile(join(fixture.workspace, "src", "wip.ts"), "utf8"), "export const wip = true;\n");
    const status = await exec("git", ["-C", fixture.workspace, "status", "--porcelain", "src/wip.ts"]);
    assert.match(status.stdout, /wip\.ts/);
  } finally {
    await teardownRepairFixture(fixture);
  }
});

test("planning repair cannot add product-source changes while PLAN metadata is invalid", async () => {
  const fixture = await setupRepairFixture();
  try {
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), CAMPSTY_641_SHAPE_PLAN);
    const initial = state(fixture.repo, fixture.workspace);
    const worker: IssueWorkerRunner = async () => {
      await mkdir(join(fixture.workspace, "src"), { recursive: true });
      await writeFile(join(fixture.workspace, "src", "forbidden.ts"), "export const productChange = true;\n");
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    await assert.rejects(
      () => runOneStep(
        { cwd: fixture.workspace } as unknown as ExtensionCommandContext,
        initial,
        1,
        worker,
        createSupervisorRuntime(),
      ),
      (error: unknown) =>
        error instanceof IssueBoundaryFailure &&
        error.stage === "execution" &&
        /changed product paths: src\/forbidden\.ts/.test(error.reason),
    );
    assert.equal(
      await readFile(join(fixture.workspace, "src", "forbidden.ts"), "utf8"),
      "export const productChange = true;\n",
    );
  } finally {
    await teardownRepairFixture(fixture);
  }
});

test("bounded planning repair that repeats the same invalid result is contained with the exact unresolved defect", async () => {
  const fixture = await setupRepairFixture();
  try {
    await writeFile(join(fixture.workspace, ".pi-next", "PLAN.md"), INVALID_PLAN);
    let initial = state(fixture.repo, fixture.workspace);
    // Pre-seed durable repair state already at the current PLAN's fingerprint
    // and at the attempt bound, so the next transition must exhaust rather
    // than grant another attempt.
    initial = {
      ...initial,
      planRepair: {
        attempts: 2,
        maxAttempts: 2,
        fingerprint: "task-metadata:files=1;approaches=1",
        lastErrors: ["Task missing Files: an earlier task", "Task missing Approach: an earlier task"],
        updatedAt: initial.updatedAt,
      },
    };
    let calls = 0;
    const worker: IssueWorkerRunner = async () => {
      calls += 1;
      return { ok: true, output: "", code: 0, signal: null, telemetry: { status: "unavailable" } };
    };
    await assert.rejects(
      () => runOneStep(
        { cwd: fixture.workspace } as unknown as ExtensionCommandContext,
        initial,
        1,
        worker,
        createSupervisorRuntime(),
      ),
      (error: unknown) =>
        error instanceof IssueBoundaryFailure &&
        error.stage === "workspace-validation" &&
        /repair exhausted after 2 bounded attempts/.test(error.reason) &&
        /Task missing Files:/.test(error.reason) &&
        /Task missing Approach:/.test(error.reason),
    );
    // A worker must never be dispatched once the bound is already exhausted.
    assert.equal(calls, 0);
    // The PLAN itself is preserved untouched; no reset/stash/delete occurred.
    assert.equal(await readFile(join(fixture.workspace, ".pi-next", "PLAN.md"), "utf8"), INVALID_PLAN);
  } finally {
    await teardownRepairFixture(fixture);
  }
});

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

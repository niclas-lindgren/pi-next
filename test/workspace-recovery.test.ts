import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  createIssueLease,
  ensureIssueWorktree,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";
import { claimLoopIssue } from "../extensions/pi-next/loop.ts";
import { commitExplicitPaths } from "../extensions/pi-next/commit-safety.ts";
import { lifecycleTelemetryFile } from "../extensions/pi-next/lifecycle-telemetry.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";

const exec = promisify(execFile);

class MemoryAuthority implements IssueLeaseAuthority {
  constructor(private current: IssueLease) {}

  async read(): Promise<IssueLease> {
    return this.current;
  }

  async create(_issueNumber: number, lease: IssueLease): Promise<void> {
    this.current = lease;
  }

  async replace(_issueNumber: number, _expected: IssueLease, lease: IssueLease): Promise<void> {
    this.current = lease;
  }

  async remove(): Promise<void> {
    this.current = undefined as never;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function state(repo: string, workspace: string, lease: IssueLease): LoopState {
  return {
    version: 1,
    runId: "run-workspace-recovery",
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: repo,
    activeIssueNumber: 7,
    activeWorkspace: workspace,
    activeLease: lease,
  };
}

async function fixture(seed?: { path: string; content: string }) {
  const root = await mkdtemp(join(tmpdir(), "pi-next-workspace-recovery-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "pi-next test");
  await writeFile(join(repo, ".gitignore"), ".pi/\n.worktrees/\n");
  await writeFile(join(repo, "README.md"), "fixture\n");
  if (seed) {
    await mkdir(join(repo, ".pi-next"), { recursive: true });
    await writeFile(join(repo, seed.path), seed.content);
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  const workspace = await ensureIssueWorktree(repo, 7);
  const lease = createIssueLease({
    issueNumber: 7,
    agent: "pi-next",
    runId: "run-workspace-recovery",
    sessionId: "session-workspace-recovery",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { root, repo, workspace, lease };
}

async function resume(fixtureState: Awaited<ReturnType<typeof fixture>>) {
  return claimLoopIssue(
    fixtureState.repo,
    state(fixtureState.repo, fixtureState.workspace, fixtureState.lease),
    new MemoryAuthority(fixtureState.lease),
  );
}

test("salvages a clean divergent legacy branch onto authoritative main", async () => {
  const fixtureState = await fixture();
  try {
    // Advance authoritative main while the legacy branch remains on the old
    // fixture base, then add one explicitly issue-attributed legacy commit.
    await writeFile(join(fixtureState.repo, "main-update.txt"), "main\n");
    await git(fixtureState.repo, "add", "main-update.txt");
    await git(fixtureState.repo, "commit", "-m", "main advances");
    await git(fixtureState.repo, "push", "origin", "main");
    await git(fixtureState.workspace, "switch", "-c", "pi-next/issue-7/legacy");
    await writeFile(join(fixtureState.workspace, "legacy-change.txt"), "legacy\n");
    await git(fixtureState.workspace, "add", "legacy-change.txt");
    await git(fixtureState.workspace, "commit", "-m", "feat: issue #7 legacy change");
    await writeFile(join(fixtureState.workspace, "legacy-followup.txt"), "followup\n");
    await git(fixtureState.workspace, "add", "legacy-followup.txt");
    await git(fixtureState.workspace, "commit", "-m", "fix: issue #7 legacy follow-up");
    await git(fixtureState.repo, "branch", "-D", "agent/issue-7");

    const recovered = await ensureIssueWorktree(fixtureState.repo, 7);
    assert.equal(recovered, fixtureState.workspace);
    assert.equal(await git(recovered, "branch", "--show-current"), "agent/issue-7");
    assert.equal(await readFile(join(recovered, "main-update.txt"), "utf8"), "main\n");
    assert.equal(await readFile(join(recovered, "legacy-change.txt"), "utf8"), "legacy\n");
    assert.equal(await readFile(join(recovered, "legacy-followup.txt"), "utf8"), "followup\n");
    const preserved = (await readdir(join(fixtureState.repo, ".worktrees"))).find((name) => name.startsWith("issue-7-legacy-"));
    assert.ok(preserved, "original legacy checkout remains as recovery evidence");
    assert.equal(await git(join(fixtureState.repo, ".worktrees", preserved!), "branch", "--show-current"), "pi-next/issue-7/legacy");
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("real issue handoff quarantines an inherited unowned artifact and continues", async () => {
  const fixtureState = await fixture({
    path: ".pi-next/VERIFY.md",
    content: "inherited generated verification state without an issue identity\n",
  });
  try {
    const before = await git(fixtureState.workspace, "rev-parse", "HEAD");
    const next = await resume(fixtureState);
    assert.equal(next.activeIssueNumber, 7);
    assert.equal(next.activeWorkspace, fixtureState.workspace);
    assert.equal(await git(fixtureState.repo, "status", "--porcelain"), "");
    assert.notEqual(await git(fixtureState.workspace, "rev-parse", "HEAD"), before);
    assert.match(await git(fixtureState.workspace, "log", "-1", "--format=%s"), /quarantine inherited workflow artifacts/);
    await assert.rejects(() => readFile(join(fixtureState.workspace, ".pi-next", "VERIFY.md")));
    assert.equal(
      await readFile(join(fixtureState.workspace, ".pi-next", "deferred", "inherited-issue-unknown-VERIFY.md"), "utf8"),
      "inherited generated verification state without an issue identity\n",
    );
    const telemetry = JSON.parse(await readFile(lifecycleTelemetryFile(fixtureState.workspace), "utf8")) as { events: Array<Record<string, unknown>> };
    assert.equal(telemetry.events.at(-1)?.event, "workflow_artifact_quarantined");
    assert.equal(telemetry.events.at(-1)?.outcome, "recovered");
    const afterRecovery = await git(fixtureState.workspace, "rev-parse", "HEAD");
    await resume(fixtureState);
    assert.equal(await git(fixtureState.workspace, "rev-parse", "HEAD"), afterRecovery);
    assert.equal((await readFile(join(fixtureState.workspace, ".pi-next", "deferred", "inherited-issue-unknown-VERIFY.md"), "utf8")).length > 0, true);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("current-issue artifacts remain active and foreign identified artifacts quarantine", async () => {
  const fixtureState = await fixture({
    path: ".pi-next/PLAN-99.md",
    content: "**GitHub-Issue:** #99\n\nforeign inherited plan\n",
  });
  try {
    await writeFile(
      join(fixtureState.workspace, ".pi-next", "PLAN.md"),
      "# Plan: Current\n\n**Goal:** keep current work\n\n**GitHub-Issue:** #7\n\n## Tasks\n- [ ] task\n  - Files: src/example.ts\n  - Approach: preserve\n\n## Acceptance Criteria\n- [ ] criterion\n\n## Log\n",
    );
    const next = await resume(fixtureState);
    assert.equal(next.activeWorkspace, fixtureState.workspace);
    assert.match(await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8"), /# Plan: Current/);
    assert.equal(
      await readFile(join(fixtureState.workspace, ".pi-next", "deferred", "inherited-issue-99-PLAN.md"), "utf8"),
      "**GitHub-Issue:** #99\n\nforeign inherited plan\n",
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("active resume ignores a coordination-root PLAN and uses the persisted workspace", async () => {
  const fixtureState = await fixture();
  try {
    await mkdir(join(fixtureState.repo, ".pi-next"), { recursive: true });
    await writeFile(
      join(fixtureState.repo, ".pi-next", "PLAN.md"),
      "stale root plan that is not ownership authority\n",
    );
    const next = await resume(fixtureState);
    assert.equal(next.activeWorkspace, fixtureState.workspace);
    await assert.rejects(
      () => commitExplicitPaths(fixtureState.repo, [".pi-next/PLAN.md"], "invalid root workflow commit", { issueNumber: 7 }),
      /canonical issue worktree/,
    );
    await assert.rejects(() => readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md")));
    await assert.rejects(() => readFile(join(fixtureState.repo, ".pi-next", "PLAN.md")));
    assert.match(
      await readFile(join(fixtureState.repo, ".pi", "runtime", "legacy-workflow", "legacy-root-unknown-PLAN.md"), "utf8"),
      /stale root plan/,
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("divergent unowned artifacts are preserved and fail handoff with provenance", async () => {
  const fixtureState = await fixture({
    path: ".pi-next/VERIFY.md",
    content: "baseline generated verification state\n",
  });
  try {
    await writeFile(join(fixtureState.workspace, ".pi-next", "VERIFY.md"), "meaningful local verification work\n");
    await assert.rejects(
      () => resume(fixtureState),
      (error: unknown) => error instanceof Error &&
        error.message.includes(".pi-next/VERIFY.md") &&
        error.message.includes("foreign or malformed workflow artifact"),
    );
    assert.equal(await readFile(join(fixtureState.workspace, ".pi-next", "VERIFY.md"), "utf8"), "meaningful local verification work\n");
    await assert.rejects(() => readFile(join(fixtureState.workspace, ".pi-next", "deferred", "inherited-issue-unknown-VERIFY.md")));
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

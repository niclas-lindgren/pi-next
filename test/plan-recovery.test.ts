import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { reconcileWorkspacePlan, validateWorkspacePlan } from "../extensions/pi-next/execution-boundary.ts";
import { PlanAuthorityError } from "../extensions/pi-next/util-core.ts";
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

function initialState(repo: string, workspace: string, lease: IssueLease): LoopState {
  return {
    version: 1,
    runId: "run-plan-recovery",
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

function plan(overrides = ""): string {
  return `# Plan: Existing issue\n\n**Goal:** preserve meaningful work\n\n**GitHub-Issue:** #7\n\n## Tasks\n- [ ] implement the bounded repair\n  - Files: src/example.ts\n  - Approach: keep the existing task and acceptance text\n\n## Acceptance Criteria\n- [ ] Existing requirements remain intact\n${overrides}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-plan-recovery-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "pi-next test");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  const workspace = await ensureIssueWorktree(repo, 7);
  await mkdir(join(workspace, ".pi-next"), { recursive: true });
  const lease = createIssueLease({
    issueNumber: 7,
    agent: "pi-next",
    runId: "run-plan-recovery",
    sessionId: "session-plan-recovery",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { root, repo, workspace, lease };
}

test("real resume claim repairs a missing log and records recovery telemetry", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), plan());
    const beforeHead = await git(fixtureState.workspace, "rev-parse", "HEAD");
    const state = await claimLoopIssue(
      fixtureState.repo,
      initialState(fixtureState.repo, fixtureState.workspace, fixtureState.lease),
      new MemoryAuthority(fixtureState.lease),
    );
    const repaired = await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.equal(state.activeWorkspace, fixtureState.workspace);
    assert.match(repaired, /## Log/);
    assert.match(repaired, /implement the bounded repair/);
    assert.match(repaired, /Existing requirements remain intact/);
    assert.equal(await git(fixtureState.workspace, "rev-parse", "HEAD"), beforeHead);

    const telemetry = JSON.parse(await readFile(lifecycleTelemetryFile(fixtureState.workspace), "utf8")) as { events: Array<Record<string, unknown>> };
    assert.deepEqual(telemetry.events.at(-1), {
      event: "plan_repaired",
      issueNumber: 7,
      runId: "run-plan-recovery",
      outcome: "recovered",
      reasonCode: "plan_repaired",
      at: telemetry.events.at(-1)?.at,
      repair: {
        paths: [join(fixtureState.workspace, ".pi-next", "PLAN.md")],
        fields: ["log"],
      },
    });
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("resume repairs a missing canonical title without changing task authority", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(
      join(fixtureState.workspace, ".pi-next", "PLAN.md"),
      plan("\n## Log\n").replace(/^# Plan: Existing issue\n\n/, ""),
    );
    validateWorkspacePlan(fixtureState.workspace, 7, { runId: "run-title-repair" });
    const repaired = await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.match(repaired, /^# Plan: Issue #7/m);
    assert.match(repaired, /implement the bounded repair/);
    assert.match(repaired, /## Log/);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("owned PLAN recovery reconstructs acceptance criteria from live authority", async () => {
  const fixtureState = await fixture();
  try {
    const incomplete = plan("\n## Log\n")
      .replace("## Acceptance Criteria\n- [ ] Existing requirements remain intact\n", "");
    await writeFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), incomplete);
    const authority = {
      name: "fixture",
      capabilities: { discovery: true, freshness: true, completion: false, atomicOwnership: false, projectStatus: false },
      listCandidates: async () => [],
      get: async () => ({
        id: "7", number: 7, title: "Live bounded repair", body: "## Acceptance Criteria\n- [ ] preserve completed work\n- [ ] retain the log", state: "open", updatedAt: "2026-01-01T00:00:00Z", priority: "P1", states: [], comments: [{ id: "decision-1", author: "maintainer", body: "Decision: preserve audit trail", createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
      }),
      fingerprint: (item: { title: string; body: string }) => `${item.title}:${item.body}`,
      close: async () => undefined,
    };
    await reconcileWorkspacePlan(fixtureState.workspace, 7, { runId: "run-live-repair", authority });
    const repaired = await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.match(repaired, /preserve completed work/);
    assert.match(repaired, /retain the log/);
    assert.match(repaired, /Decision: preserve audit trail/);
    assert.match(repaired, /implement the bounded repair/);
    assert.match(repaired, /Authority reconciliation authority=/);
    assert.doesNotThrow(() => validateWorkspacePlan(fixtureState.workspace, 7));
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("non-material authority comments do not churn acceptance criteria", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), plan("\n## Log\n").replace("## Acceptance Criteria\n- [ ] Existing requirements remain intact\n", ""));
    const authority = {
      name: "quiet", capabilities: { discovery: true, freshness: true, completion: false, atomicOwnership: false, projectStatus: false }, listCandidates: async () => [],
      get: async () => ({ id: "7", number: 7, title: "Live bounded repair", body: "## Acceptance Criteria\n- [ ] Existing requirements remain intact", state: "open", states: [], comments: [{ id: "noise", author: "reviewer", body: "Looks good, thanks!", createdAt: "2026-01-01", updatedAt: "2026-01-01" }] }), fingerprint: (item: { body: string }) => item.body, close: async () => undefined,
    };
    await reconcileWorkspacePlan(fixtureState.workspace, 7, { authority });
    const repaired = await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.match(repaired, /Existing requirements remain intact/);
    assert.doesNotMatch(repaired, /Looks good/);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("mechanical repair runs before an authority failure", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), plan("").replace(/## Acceptance Criteria[\s\S]*$/, ""));
    await assert.rejects(
      () => reconcileWorkspacePlan(fixtureState.workspace, 7, { runId: "run-bounded-repair", authority: {
        name: "empty", capabilities: { discovery: true, freshness: true, completion: false, atomicOwnership: false, projectStatus: false }, listCandidates: async () => [], get: async () => ({ id: "7", number: 7, title: "", body: "", state: "open", states: [], comments: [] }), fingerprint: () => "empty", close: async () => undefined,
      } }),
      /provided none/,
    );
    const repaired = await readFile(join(fixtureState.workspace, ".pi-next", "PLAN.md"), "utf8");
    assert.match(repaired, /## Log/);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("resume fails closed when requirements cannot be reconstructed", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(
      join(fixtureState.workspace, ".pi-next", "PLAN.md"),
      plan("\n## Log\n").replace("## Acceptance Criteria\n- [ ] Existing requirements remain intact\n", ""),
    );
    assert.throws(
      () => validateWorkspacePlan(fixtureState.workspace, 7, { runId: "run-unsafe-plan" }),
      (error: unknown) => error instanceof PlanAuthorityError && /unsafe or ambiguous|No acceptance criteria/.test(error.message),
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

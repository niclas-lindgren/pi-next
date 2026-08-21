import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  createIssueLease,
  InMemoryWorkAuthority,
  type AuthorityWorkItem,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";
import { claimLoopIssue } from "../extensions/pi-next/loop.ts";
import { lifecycleTelemetryFile } from "../extensions/pi-next/lifecycle-telemetry.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";
import { renderAutoProgress } from "../extensions/pi-next/auto-progress.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function item(number: number): AuthorityWorkItem {
  return {
    id: String(number),
    number,
    title: `candidate ${number}`,
    body: "",
    state: "open",
    updatedAt: "2026-08-21T00:00:00Z",
    priority: "P0",
    states: ["priority: P0", "status:ready"],
    comments: [],
  };
}

function state(repo: string, schedulerSkips: LoopState["schedulerSkips"] = []): LoopState {
  return {
    version: 1,
    runId: "run-scheduler-race",
    sessionId: "session-scheduler-race",
    requestedIssues: 2,
    remainingIssues: 2,
    step: 0,
    settledStep: 0,
    maxSteps: 10,
    completedIssues: [],
    deferredIssues: [],
    schedulerSkips,
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: repo,
  };
}

function foreignLease(issueNumber: number): IssueLease {
  return createIssueLease({
    issueNumber,
    agent: "another-agent",
    runId: "foreign-run",
    sessionId: "foreign-session",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

class RaceAuthority implements IssueLeaseAuthority {
  readonly reads = new Map<number, number>();
  readonly created: number[] = [];
  readonly replaced: number[] = [];
  private readonly leases = new Map<number, IssueLease>();

  constructor(private readonly raceIssue?: number, initial: IssueLease[] = []) {
    for (const lease of initial) this.leases.set(lease.issueNumber, lease);
  }

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    const count = (this.reads.get(issueNumber) || 0) + 1;
    this.reads.set(issueNumber, count);
    if (issueNumber === this.raceIssue && count >= 2 && !this.leases.has(issueNumber)) {
      const lease = foreignLease(issueNumber);
      this.leases.set(issueNumber, lease);
      return lease;
    }
    return this.leases.get(issueNumber);
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    this.created.push(issueNumber);
    this.leases.set(issueNumber, lease);
  }

  async replace(issueNumber: number, _expected: IssueLease, lease: IssueLease): Promise<void> {
    this.replaced.push(issueNumber);
    this.leases.set(issueNumber, lease);
  }

  async remove(issueNumber: number): Promise<void> {
    this.leases.delete(issueNumber);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-scheduler-race-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "pi-next test");
  await writeFile(join(repo, ".gitignore"), ".pi-next/\n.worktrees/\n");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  return { root, repo };
}

const authority = new InMemoryWorkAuthority([item(7), item(8)]);

// This is the outer scheduler/claim path, not a direct helper test: the real
// shortlist reads ownership, the CAS claim loses, durable state is written,
// and the next candidate is then handed off to its canonical worktree.
test("fresh-owner claim race skips only the candidate and continues to the next issue", async () => {
  const fixtureState = await fixture();
  try {
    const leases = new RaceAuthority(7);
    const next = await claimLoopIssue(
      fixtureState.repo,
      state(fixtureState.repo),
      leases,
      authority,
    );

    assert.equal(next.activeIssueNumber, 8);
    assert.equal(next.status, "running");
    assert.deepEqual(next.schedulerSkips?.map((skip) => skip.issueNumber), [7]);
    assert.equal(next.schedulerSkips?.[0]?.reasonCode, "fresh_owner");
    assert.equal(next.issueMetrics.find((metric) => metric.issueNumber === 7)?.disposition, "leased_elsewhere");
    assert.equal(next.lastOutcome, "yield_issue");
    assert.match(next.lastReason || "", /#7.*leased elsewhere.*fresh_owner/);
    assert.deepEqual(leases.created, [8]);
    assert.deepEqual(leases.replaced, []);
    assert.equal(await git(join(fixtureState.repo, ".worktrees", "issue-8"), "branch", "--show-current"), "agent/issue-8");
    const telemetry = JSON.parse(await readFile(lifecycleTelemetryFile(fixtureState.repo), "utf8")) as { events: Array<{ event: string; issueNumber: number; reasonCode?: string }> };
    assert.ok(telemetry.events.some((event) => event.event === "scheduler_skip" && event.issueNumber === 7 && event.reasonCode === "fresh_owner"));
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("a fresh lease already present during shortlist is filtered without mutating that issue", async () => {
  const fixtureState = await fixture();
  try {
    const leases = new RaceAuthority(undefined, [foreignLease(7)]);
    const next = await claimLoopIssue(
      fixtureState.repo,
      state(fixtureState.repo),
      leases,
      new InMemoryWorkAuthority([item(7), item(8)]),
    );

    assert.equal(next.activeIssueNumber, 8);
    assert.deepEqual(leases.created, [8]);
    assert.deepEqual(leases.replaced, []);
    assert.equal(leases.reads.get(7), 1, "pre-filtered foreign lease is not claimed or handed off");
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("when all remaining candidates are leased the scheduler settles idle, not failed", async () => {
  const fixtureState = await fixture();
  try {
    const leases = new RaceAuthority(undefined, [foreignLease(8)]);
    const next = await claimLoopIssue(
      fixtureState.repo,
      state(fixtureState.repo, [{ issueNumber: 7, reasonCode: "fresh_owner", reason: "leased elsewhere", skippedAt: new Date().toISOString() }]),
      leases,
      new InMemoryWorkAuthority([item(8)]),
    );

    assert.equal(next.status, "idle");
    assert.equal(next.lastOutcome, "idle");
    assert.equal(next.activeIssueNumber, undefined);
    assert.deepEqual(leases.created, []);
    assert.deepEqual(leases.replaced, []);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("progress distinguishes leased-elsewhere skips from settled work", () => {
  const rendered = renderAutoProgress({
    ...state("/tmp", [{ issueNumber: 7, reasonCode: "fresh_owner", reason: "leased elsewhere", skippedAt: new Date().toISOString() }]),
    lastOutcome: "yield_issue",
    lastReason: "Issue #7 skipped: leased elsewhere (fresh_owner)",
  }, { width: 160 });
  assert.match(rendered, /leased elsewhere/);
  assert.match(rendered, /⏭1/);
  assert.match(rendered, /0\/2 settled/);
});

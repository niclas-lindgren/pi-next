import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { runProductionLifecycleScheduler, runProductionSingleIssueLifecycle } from "../extensions/pi-next/production-lifecycle.ts";
import { loopStateFile, readLoopState, emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";
import { writeJsonAtomic } from "../extensions/pi-next/util.ts";
import { renderLoopStatus } from "../extensions/pi-next/loop-status.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";
import { createIssueLease } from "../src/coordination/issue-authority.ts";
import { DEFAULT_PI_NEXT_CONFIG, type PiNextConfig } from "../src/coordination/config.ts";
import type { BootstrapReport } from "../src/bootstrap/types.ts";
import type { IssueLease, IssueLeaseAuthority } from "../src/coordination/issue-leases.ts";

const exec = promisify(execFile);
const zero = "0".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-production-lifecycle-"));
  await mkdir(join(root, ".pi-next"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--initial-branch=main", root]);
  await exec("git", ["-C", root, "config", "user.email", "production@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "production test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "baseline"]);
  const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as PiNextConfig;
  config.authority.adapter = "memory";
  await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(config));
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function item(issueNumber: number): AuthorityWorkItem {
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: `Issue ${issueNumber}`,
    body: "body",
    state: "open",
    states: ["ready"],
    comments: [],
    priority: "P1",
    updatedAt: new Date(0).toISOString(),
  };
}

function report(issueNumber: number): BootstrapReport {
  return {
    issueNumber,
    attempts: 1,
    start: new Date(0).toISOString(),
    end: new Date(1).toISOString(),
    disposition: "pass",
    branch: `agent/issue-${issueNumber}`,
    worktree: `.worktrees/issue-${issueNumber}`,
    revision: zero,
    baselineRevision: zero,
    candidate: { headRevision: zero, baselineRevision: zero, originMainRevision: zero, mergeBaseRevision: zero, dirty: true, changedFiles: ["README.md"], committedChanges: false, uncommittedChanges: true, committedFiles: [], stagedFiles: [], unstagedFiles: ["README.md"], untrackedFiles: [], commitsAheadOfMergeBase: 0, commitsAheadOfOriginMain: 0, commitsBehindOriginMain: 0, behindOriginMain: false, divergedFromOriginMain: false },
    dependencySetup: { action: "not-required" },
    workerAttempts: [],
    checks: ["npm run typecheck", "npm test"].map((command) => ({ command, exitCode: 0, passed: true, durationMs: 1 })),
    mechanicalPass: true,
    candidateReadyForReview: true,
    finalizationReady: false,
    implementationOutcome: "implemented",
    candidateHasDelta: true,
  };
}

const leaseAuthority = {
  read: async () => undefined,
  create: async () => undefined,
  replace: async () => undefined,
  remove: async () => undefined,
};

/** A real compare-and-swap store, unlike the always-empty stub above, so a
 * genuine claim race between two concurrent schedulers has exactly one
 * winner. */
class CasLeaseAuthority implements IssueLeaseAuthority {
  protected readonly leases = new Map<number, IssueLease>();

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    return this.leases.get(issueNumber);
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    if (this.leases.has(issueNumber)) throw new Error("already exists");
    this.leases.set(issueNumber, lease);
  }

  async replace(issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    if (this.leases.get(issueNumber) !== expected) throw new Error("compare-and-swap failed");
    this.leases.set(issueNumber, lease);
  }

  async remove(issueNumber: number, expected: IssueLease): Promise<void> {
    if (this.leases.get(issueNumber) !== expected) throw new Error("compare-and-swap failed");
    this.leases.delete(issueNumber);
  }
}

class CreateRaceLeaseAuthority extends CasLeaseAuthority {
  private raced = false;

  constructor(private readonly raceIssue: number) {
    super();
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    if (issueNumber === this.raceIssue && !this.raced) {
      this.raced = true;
      const now = Date.now();
      this.leases.set(issueNumber, createIssueLease({
        issueNumber,
        agent: "another-agent",
        runId: "foreign-run",
        sessionId: "foreign-session",
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }));
      throw new Error("compare-and-swap failed");
    }
    await super.create(issueNumber, lease);
  }
}

test("production explicit issue execution invokes the shared single-issue kernel", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(647)]);
    const result = await runProductionSingleIssueLifecycle({
      cwd: f.root,
      issueNumber: 647,
      entry: "explicit",
      runId: "explicit-production-647",
      finalize: false,
    }, { authority, config: f.config }, async (options) => report(options.issueNumber));
    assert.equal(result.issueNumber, 647);
    assert.equal(result.runId, "explicit-production-647");
    assert.equal(result.projection.activeIssue, 647);
    assert.equal(result.finalization, "SKIPPED");
  } finally {
    await f.cleanup();
  }
});

test("production auto is a scheduler over the shared lifecycle and re-queries authority between issues", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(201), item(202)]);
    const seen: number[] = [];
    const result = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 2,
      runId: "prod-auto-parity",
    }, { authority, config: f.config, leaseAuthority }, async (options) => {
      seen.push(options.issueNumber);
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });
    assert.equal(result.disposition, "budget-yield");
    assert.deepEqual(seen, [201, 202]);
    assert.deepEqual(result.results.map((entry) => entry.disposition), ["pass", "pass"]);
  } finally {
    await f.cleanup();
  }
});

test("production auto settles disposition 'completed' when the candidate queue is exhausted before the requested budget", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(401)]);
    const result = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 5,
      runId: "prod-auto-completed",
    }, { authority, config: f.config, leaseAuthority }, async (options) => {
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });
    assert.equal(result.disposition, "completed");
    assert.deepEqual(result.results.map((entry) => entry.disposition), ["pass"]);
    const state = readLoopState(f.root, "prod-auto-completed");
    assert.equal(state?.status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("production auto persists the caller's session id so the footer heartbeat can find the current run by session (#166)", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(301)]);
    const ctx = { cwd: f.root, sessionManager: { getSessionId: () => "footer-session" } };
    await runProductionLifecycleScheduler({
      cwd: f.root,
      ctx: ctx as never,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-session",
    }, { authority, config: f.config, leaseAuthority }, async (options) => {
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });
    const state = readLoopState(f.root, "prod-auto-session");
    assert.equal(state?.sessionId, "footer-session");
  } finally {
    await f.cleanup();
  }
});

test("two fresh production auto schedulers racing the same issue: exactly one claims and executes, the loser mutates nothing (#146)", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(900)]);
    const sharedLeaseAuthority = new CasLeaseAuthority();
    const executed: number[] = [];

    // Deterministically force overlap at the exact moment that matters: the
    // second scheduler must attempt selection/claim while the first still
    // authoritatively holds the lease, proving a live race is resolved to
    // exactly one owner rather than merely never colliding by luck.
    let resolveFirstClaimed: () => void;
    const firstClaimed = new Promise<void>((resolve) => { resolveFirstClaimed = resolve; });
    const originalCreate = sharedLeaseAuthority.create.bind(sharedLeaseAuthority);
    sharedLeaseAuthority.create = async (issueNumber, lease) => {
      await originalCreate(issueNumber, lease);
      resolveFirstClaimed();
    };
    let releaseFirstWorker: () => void;
    const secondHasRaced = new Promise<void>((resolve) => { releaseFirstWorker = resolve; });

    const firstPromise = runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-race-a",
    }, { authority, config: f.config, leaseAuthority: sharedLeaseAuthority }, async (options) => {
      executed.push(options.issueNumber);
      await secondHasRaced;
      return report(options.issueNumber);
    });

    await firstClaimed;
    const second = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-race-b",
    }, { authority, config: f.config, leaseAuthority: sharedLeaseAuthority }, async (options) => {
      executed.push(options.issueNumber);
      return report(options.issueNumber);
    });
    releaseFirstWorker!();
    const first = await firstPromise;

    // Exactly one scheduler ever ran the worker for #900.
    assert.deepEqual(executed, [900]);
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0]!.disposition, "pass");
    // The loser never mutated anything: it safely continued/requeried and
    // ended idle instead of throwing, stalling, or stopping the process.
    assert.equal(second.results.length, 0);
    assert.equal(second.disposition, "idle");
    // The lease is fully released after the winner's issue settles.
    assert.equal(await sharedLeaseAuthority.read(900), undefined);
  } finally {
    await f.cleanup();
  }
});

test("production auto records fresh leases found during discovery in canonical loop state before continuing (#73)", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(711), item(712)]);
    const sharedLeaseAuthority = new CasLeaseAuthority();
    const now = Date.now();
    await sharedLeaseAuthority.create(711, createIssueLease({
      issueNumber: 711,
      agent: "another-agent",
      runId: "foreign-run",
      sessionId: "foreign-session",
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    }));
    const executed: number[] = [];

    const result = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-discovery-skip-state",
    }, { authority, config: f.config, leaseAuthority: sharedLeaseAuthority }, async (options) => {
      executed.push(options.issueNumber);
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });

    assert.equal(result.disposition, "budget-yield");
    assert.deepEqual(executed, [712]);
    const state = readLoopState(f.root, "prod-auto-discovery-skip-state");
    assert.deepEqual(state?.schedulerSkips?.map((skip) => skip.issueNumber), [711]);
    assert.equal(state?.schedulerSkips?.[0]?.reasonCode, "fresh_owner");
    assert.equal(state?.issueMetrics.find((metric) => metric.issueNumber === 711)?.disposition, "leased_elsewhere");
    assert.deepEqual(state?.completedIssues, [712]);
    assert.equal(state?.remainingIssues, 0);
  } finally {
    await f.cleanup();
  }
});

test("production auto records fresh-owner claim races in canonical loop state before continuing (#73)", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(701), item(702)]);
    const sharedLeaseAuthority = new CreateRaceLeaseAuthority(701);
    const executed: number[] = [];

    const result = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-race-skip-state",
    }, { authority, config: f.config, leaseAuthority: sharedLeaseAuthority }, async (options) => {
      executed.push(options.issueNumber);
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });

    assert.equal(result.disposition, "budget-yield");
    assert.deepEqual(executed, [702]);
    const state = readLoopState(f.root, "prod-auto-race-skip-state");
    assert.deepEqual(state?.schedulerSkips?.map((skip) => skip.issueNumber), [701]);
    assert.equal(state?.schedulerSkips?.[0]?.reasonCode, "fresh_owner");
    assert.equal(state?.issueMetrics.find((metric) => metric.issueNumber === 701)?.disposition, "leased_elsewhere");
    assert.deepEqual(state?.completedIssues, [702]);
    assert.equal(state?.remainingIssues, 0);
  } finally {
    await f.cleanup();
  }
});

test("production auto cancellation after claim releases ownership before any lifecycle worker starts (#73)", async () => {
  const f = await fixture();
  try {
    const authority = new InMemoryWorkAuthority([item(901)]);
    const sharedLeaseAuthority = new CasLeaseAuthority();
    const controller = new AbortController();
    const executed: number[] = [];
    const originalCreate = sharedLeaseAuthority.create.bind(sharedLeaseAuthority);
    sharedLeaseAuthority.create = async (issueNumber, lease) => {
      await originalCreate(issueNumber, lease);
      controller.abort("stop after scheduler claim");
    };

    const result = await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "prod-auto-abort-after-claim",
      signal: controller.signal,
    }, { authority, config: f.config, leaseAuthority: sharedLeaseAuthority }, async (options) => {
      executed.push(options.issueNumber);
      return report(options.issueNumber);
    });

    assert.equal(result.disposition, "cancelled");
    assert.equal(result.settled, 0);
    assert.deepEqual(executed, []);
    assert.equal(await sharedLeaseAuthority.read(901), undefined);
    const state = readLoopState(f.root, "prod-auto-abort-after-claim");
    assert.equal(state?.status, "cancelled");
    assert.equal(state?.activeIssueNumber, undefined);
  } finally {
    await f.cleanup();
  }
});

test("production footer/status projects the current unified lifecycle run, not stale historical state", async () => {
  const f = await fixture();
  try {
    const stale: LoopState = {
      version: 1,
      runId: "stale-640",
      sessionId: "session-1",
      requestedIssues: 1,
      remainingIssues: 0,
      step: 1,
      settledStep: 1,
      maxSteps: 10,
      completedIssues: [],
      deferredIssues: [],
      issueMetrics: [],
      status: "stopped",
      stopRequested: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metrics: emptyLoopMetrics(),
      coordinationCwd: f.root,
      activeIssueNumber: 640,
      lastReason: "budget yielded",
    };
    writeJsonAtomic(loopStateFile(f.root, stale.runId), stale);
    const authority = new InMemoryWorkAuthority([item(647)]);
    await runProductionLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      requestedIssues: 1,
      runId: "r:98408835",
    }, { authority, config: f.config, leaseAuthority }, async (options) => {
      await authority.close(String(options.issueNumber), "done");
      return report(options.issueNumber);
    });
    const status = renderLoopStatus(f.root, undefined, "r:98408835", "summary");
    assert.match(status, /Current run: r:98408835 · #647/);
    assert.doesNotMatch(status.split("\n")[0] || "", /#640/);
  } finally {
    await f.cleanup();
  }
});

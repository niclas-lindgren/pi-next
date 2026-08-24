import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { runProductionLifecycleScheduler, runProductionSingleIssueLifecycle } from "../extensions/pi-next/production-lifecycle.ts";
import { loopStateFile, emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";
import { writeJsonAtomic } from "../extensions/pi-next/util.ts";
import { renderLoopStatus } from "../extensions/pi-next/loop-status.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";
import { DEFAULT_PI_NEXT_CONFIG, type PiNextConfig } from "../src/coordination/config.ts";
import type { BootstrapReport } from "../src/bootstrap/types.ts";

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

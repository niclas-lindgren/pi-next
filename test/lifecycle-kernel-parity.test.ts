import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { runBootstrapLifecycle, type BootstrapReport } from "../src/bootstrap/index.ts";
import { runSingleIssueLifecycle, runLifecycleScheduler, LifecycleSchedulerClaimConflict, type UnifiedLifecycleResult } from "../src/lifecycle/index.ts";

const exec = promisify(execFile);
const zero = "0".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-kernel-parity-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--initial-branch=main", root]);
  await exec("git", ["-C", root, "config", "user.email", "kernel@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "kernel test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "baseline"]);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function report(issueNumber: number, patch: Partial<BootstrapReport> = {}): BootstrapReport {
  const candidateHasDelta = patch.candidateHasDelta ?? true;
  const mechanicalPass = patch.mechanicalPass ?? true;
  return {
    issueNumber,
    attempts: 1,
    start: new Date(0).toISOString(),
    end: new Date(1).toISOString(),
    disposition: mechanicalPass ? (candidateHasDelta ? "pass" : "no-change") : "repairable-failure",
    branch: `agent/issue-${issueNumber}`,
    worktree: `.worktrees/issue-${issueNumber}`,
    revision: zero,
    baselineRevision: zero,
    candidate: { headRevision: zero, baselineRevision: zero, originMainRevision: zero, mergeBaseRevision: zero, dirty: candidateHasDelta, changedFiles: candidateHasDelta ? ["README.md"] : [], committedChanges: false, uncommittedChanges: candidateHasDelta, committedFiles: [], stagedFiles: [], unstagedFiles: candidateHasDelta ? ["README.md"] : [], untrackedFiles: [], commitsAheadOfMergeBase: 0, commitsAheadOfOriginMain: 0, commitsBehindOriginMain: 0, behindOriginMain: false, divergedFromOriginMain: false },
    dependencySetup: { action: "not-required" },
    workerAttempts: [],
    checks: ["npm run typecheck", "npm test"].map((command) => ({ command, exitCode: mechanicalPass ? 0 : 1, passed: mechanicalPass, durationMs: 1 })),
    mechanicalPass,
    candidateReadyForReview: mechanicalPass && candidateHasDelta,
    finalizationReady: mechanicalPass && candidateHasDelta,
    implementationOutcome: candidateHasDelta ? "implemented" : "unproven-no-change",
    candidateHasDelta,
    ...patch,
  };
}

function comparable(result: { disposition: unknown; implementation: unknown; verification: unknown; finalization: unknown; repair?: unknown; candidatePreserved?: unknown; implementationReport: BootstrapReport }) {
  return {
    disposition: result.disposition,
    implementation: result.implementation,
    verification: result.verification,
    finalization: result.finalization,
    repair: result.repair,
    candidatePreserved: result.candidatePreserved,
    implementationOutcome: result.implementationReport.implementationOutcome,
    mechanicalPass: result.implementationReport.mechanicalPass,
    candidateHasDelta: result.implementationReport.candidateHasDelta,
  };
}

test("bootstrap and explicit entry invoke the same single-issue lifecycle kernel", async () => {
  const f = await fixture();
  try {
    const execute = async () => report(146);
    const bootstrap = await runBootstrapLifecycle({ cwd: f.root, issueNumber: 146, allowRepair: true, review: false, finalize: false }, {}, execute);
    const explicit = await runSingleIssueLifecycle({ cwd: f.root, workItem: { issueNumber: 146 }, allowRepair: true, review: false, finalize: false, entry: "explicit", runId: "explicit-146" }, {}, execute);
    assert.deepEqual(comparable(bootstrap), comparable(explicit));
  } finally { await f.cleanup(); }
});

test("repair-budget-exhausted disposition is identical across bootstrap and auto kernel entries", async () => {
  const f = await fixture();
  try {
    const exhausted = report(147, { mechanicalPass: false, disposition: "repairable-failure", repairOutcome: "exhausted", repairBudgetExhausted: true });
    const execute = async () => exhausted;
    const bootstrap = await runBootstrapLifecycle({ cwd: f.root, issueNumber: 147, allowRepair: true, review: false, finalize: false }, {}, execute);
    const auto = await runSingleIssueLifecycle({ cwd: f.root, workItem: { issueNumber: 147 }, allowRepair: true, review: false, finalize: false, entry: "auto", runId: "auto-147" }, {}, execute);
    assert.deepEqual(comparable(bootstrap), comparable(auto));
    assert.equal(auto.projection.activeIssue, 147);
    assert.equal(auto.projection.runId, "auto-147");
    assert.equal(auto.projection.terminalDisposition, "repairable-failure");
  } finally { await f.cleanup(); }
});

test("auto scheduler only selects/requeries and never changes lifecycle semantics", async () => {
  const f = await fixture();
  try {
    const seen: number[] = [];
    const requery: number[] = [];
    const execute = async (options: { issueNumber: number }) => report(options.issueNumber);
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-1",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 2 },
      discover: async () => {
        const next = seen.length === 0 ? 201 : seen.length === 1 ? 202 : undefined;
        if (next) seen.push(next);
        return next ? { issueNumber: next } : undefined;
      },
      requeryAuthority: async (result) => { requery.push(result.issueNumber); },
    }, {}, execute as never);
    assert.equal(scheduler.disposition, "budget-yield");
    assert.deepEqual(scheduler.results.map((r) => comparable(r)), [comparable({ ...scheduler.results[0]! }), comparable({ ...scheduler.results[1]! })]);
    assert.deepEqual(requery, [201, 202]);
  } finally { await f.cleanup(); }
});

test("bootstrap and production entries share stale-proof finalization-blocked disposition", async () => {
  const f = await fixture();
  try {
    const execute = async () => report(156);
    const runFinalizer = async () => {
      const error = new Error("live candidate supersedes stale proof but is dirty");
      (error as Error & { code: string }).code = "STALE_PROOF_LIVE_CANDIDATE_DIRTY";
      throw error;
    };
    const bootstrap = await runBootstrapLifecycle({ cwd: f.root, issueNumber: 156, allowRepair: true, review: false, finalize: true }, { runFinalizer }, execute);
    const production = await runSingleIssueLifecycle({ cwd: f.root, workItem: { issueNumber: 156 }, allowRepair: true, review: false, finalize: true, entry: "auto", runId: "auto-156" }, { runFinalizer }, execute);
    assert.equal(bootstrap.disposition, "finalization-blocked");
    assert.equal(production.disposition, "finalization-blocked");
    assert.deepEqual(bootstrap.finalizationFailure, production.finalizationFailure);
    assert.equal(production.projection.terminalDisposition, "finalization-blocked");
  } finally { await f.cleanup(); }
});

test("bootstrap and production entries share dirty-baseline finalization divergence outcome", async () => {
  const f = await fixture();
  try {
    const execute = async () => report(158, {
      candidate: {
        ...report(158).candidate,
        headRevision: "a".repeat(40),
        baselineRevision: "a".repeat(40),
        originMainRevision: "b".repeat(40),
        dirty: true,
        committedChanges: false,
        uncommittedChanges: true,
        changedFiles: ["README.md", "new-source.ts"],
      },
    });
    const runFinalizer = async () => {
      const error = new Error("origin/main advanced with unrelated commits during finalize; re-verify against current main");
      (error as Error & { code: string }).code = "REQUIRES_REVERIFICATION";
      throw error;
    };
    const bootstrap = await runBootstrapLifecycle({ cwd: f.root, issueNumber: 158, allowRepair: true, review: false, finalize: true }, { runFinalizer }, execute);
    const production = await runSingleIssueLifecycle({ cwd: f.root, workItem: { issueNumber: 158 }, allowRepair: true, review: false, finalize: true, entry: "auto", runId: "auto-158" }, { runFinalizer }, execute);
    assert.equal(bootstrap.disposition, "finalization-blocked");
    assert.equal(production.disposition, "finalization-blocked");
    assert.deepEqual(bootstrap.finalizationFailure, production.finalizationFailure);
    assert.equal(production.candidatePreserved, true);
  } finally { await f.cleanup(); }
});

test("scheduler claim conflict is a scheduler-local skip, not a global stop (#146)", async () => {
  const f = await fixture();
  try {
    const excluded = new Set<number>();
    const discovered: number[] = [];
    const claimed: number[] = [];
    const conflicts: number[] = [];
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-claim-conflict",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 1 },
      discover: async () => {
        discovered.push(900);
        return excluded.has(900) ? undefined : { issueNumber: 900 };
      },
      claim: async (selection) => {
        throw new LifecycleSchedulerClaimConflict(selection);
      },
      onClaimConflict: (selection) => {
        conflicts.push(selection.issueNumber);
        excluded.add(selection.issueNumber);
      },
    }, {}, async (options: { issueNumber: number }) => {
      claimed.push(options.issueNumber);
      return report(options.issueNumber);
    });
    assert.equal(scheduler.disposition, "idle");
    assert.equal(scheduler.results.length, 0);
    assert.deepEqual(conflicts, [900]);
    assert.equal(claimed.length, 0, "a lost claim race must never execute the worker");
    assert.equal(discovered.length, 2, "the scheduler must requery discovery after a claim conflict instead of stopping");
  } finally { await f.cleanup(); }
});

test("scheduler releases a successful claim after the issue settles, before requerying authority (#146)", async () => {
  const f = await fixture();
  try {
    const order: string[] = [];
    const execute = async (options: { issueNumber: number }) => {
      order.push("execute");
      return report(options.issueNumber);
    };
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-claim-release",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 1 },
      discover: async () => ({ issueNumber: 900 }),
      claim: async () => ({ release: async () => { order.push("release"); } }),
      requeryAuthority: async () => { order.push("requery"); },
    }, {}, execute as never);
    assert.equal(scheduler.disposition, "budget-yield");
    assert.deepEqual(order, ["execute", "release", "requery"]);
  } finally { await f.cleanup(); }
});

test("canonical projection prevents Campsty #647-style footer/worker contradiction", async () => {
  const f = await fixture();
  try {
    const events: Array<{ activeIssue?: number; runId: string; terminal?: UnifiedLifecycleResult["disposition"] }> = [];
    const result = await runSingleIssueLifecycle({
      cwd: f.root,
      workItem: { issueNumber: 647 },
      allowRepair: true,
      review: false,
      finalize: false,
      entry: "auto",
      runId: "r:98408835",
      reporter: (event) => {
        if (event.projection) events.push({ activeIssue: event.projection.activeIssue, runId: event.projection.runId, terminal: event.projection.terminalDisposition });
      },
    }, {}, async () => report(647));
    assert.equal(result.projection.activeIssue, 647);
    assert.equal(result.projection.runId, "r:98408835");
    assert.equal(events.every((event) => event.activeIssue === 647 && event.runId === "r:98408835"), true);
    assert.equal(events.some((event) => event.activeIssue === 640), false);
  } finally { await f.cleanup(); }
});

test("scheduler reports cancelled before selection when already aborted (#165)", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const discovered: number[] = [];
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-cancel-before-selection",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 2 },
      signal: controller.signal,
      discover: async () => {
        discovered.push(1);
        return { issueNumber: 900 };
      },
    }, {}, async (options: { issueNumber: number }) => report(options.issueNumber));
    assert.equal(scheduler.disposition, "cancelled");
    assert.equal(scheduler.settled, 0);
    assert.equal(discovered.length, 0, "an already-aborted run must never call discover");
  } finally { await f.cleanup(); }
});

test("scheduler reports cancelled before claim when abort lands during selection (#165)", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const claimed: number[] = [];
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-cancel-before-claim",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 2 },
      signal: controller.signal,
      discover: async () => {
        // Selection itself resolves the abort, mirroring a stop request that
        // lands while discovery is in flight.
        controller.abort();
        return { issueNumber: 901 };
      },
      claim: async (selection) => {
        claimed.push(selection.issueNumber);
        return { release: async () => {} };
      },
    }, {}, async (options: { issueNumber: number }) => report(options.issueNumber));
    assert.equal(scheduler.disposition, "cancelled");
    assert.equal(scheduler.settled, 0);
    assert.deepEqual(claimed, [], "a selection made just before abort must never go on to claim");
  } finally { await f.cleanup(); }
});

test("scheduler reports cancelled between issue iterations instead of discovering another candidate (#165)", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const discovered: number[] = [];
    const scheduler = await runLifecycleScheduler({
      cwd: f.root,
      runId: "queue-cancel-between-issues",
      allowRepair: true,
      review: false,
      finalize: false,
      policy: { maxIssues: 2 },
      signal: controller.signal,
      discover: async () => {
        discovered.push(discovered.length);
        return discovered.length === 1 ? { issueNumber: 902 } : undefined;
      },
    }, {}, async (options: { issueNumber: number }) => {
      // Abort lands while this issue's own lifecycle/worker boundary is
      // still in flight (the same signal is threaded through to it).
      controller.abort();
      return report(options.issueNumber);
    });
    assert.equal(scheduler.disposition, "cancelled");
    assert.equal(scheduler.settled, 1);
    assert.equal(scheduler.latest?.issueNumber, 902);
    assert.equal(discovered.length, 1, "an abort observed after the first issue settles must not discover a second candidate");
  } finally { await f.cleanup(); }
});

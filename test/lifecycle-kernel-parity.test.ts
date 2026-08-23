import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { runBootstrapLifecycle, type BootstrapReport } from "../src/bootstrap/index.ts";
import { runSingleIssueLifecycle, runLifecycleScheduler, type UnifiedLifecycleResult } from "../src/lifecycle/index.ts";

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

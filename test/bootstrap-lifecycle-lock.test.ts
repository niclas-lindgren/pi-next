import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { acquireBootstrapLifecycleLock, BootstrapLifecycleLockError } from "../src/bootstrap/lifecycle-lock.ts";
import { runBootstrapLifecycle, type BootstrapReport } from "../scripts/bootstrap-self-host.ts";
import { runBootstrapFinalize, type CommandRunner } from "../scripts/bootstrap-finalize.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-lifecycle-lock-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--initial-branch=main", root]);
  await git(root, "config", "user.email", "lock@example.invalid");
  await git(root, "config", "user.name", "lock test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function report(issueNumber: number): BootstrapReport {
  return {
    issueNumber,
    attempts: 0,
    start: new Date(0).toISOString(),
    end: new Date(0).toISOString(),
    disposition: "pass",
    branch: `agent/issue-${issueNumber}`,
    worktree: `.worktrees/issue-${issueNumber}`,
    revision: "0".repeat(40),
    baselineRevision: "0".repeat(40),
    candidate: { headRevision: "0".repeat(40), baselineRevision: "0".repeat(40), originMainRevision: "0".repeat(40), mergeBaseRevision: "0".repeat(40), dirty: true, changedFiles: ["README.md"], committedChanges: false, uncommittedChanges: true, committedFiles: [], stagedFiles: [], unstagedFiles: ["README.md"], untrackedFiles: [], commitsAheadOfMergeBase: 0, commitsAheadOfOriginMain: 0, commitsBehindOriginMain: 0, behindOriginMain: false, divergedFromOriginMain: false },
    dependencySetup: { action: "not-required" },
    workerAttempts: [],
    checks: [{ command: "npm run typecheck", exitCode: 0, passed: true, durationMs: 1 }, { command: "npm test", exitCode: 0, passed: true, durationMs: 1 }],
    mechanicalPass: true,
    candidateReadyForReview: true,
    finalizationReady: true,
    implementationOutcome: "implemented",
    candidateHasDelta: true,
  };
}

test("same issue lifecycle lock is exclusive and unrelated issues do not conflict", async () => {
  const f = await fixture();
  try {
    const first = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 114, operation: "self-host", phase: "worker", heartbeatMs: 0 });
    await assert.rejects(() => acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 114, operation: "finalize", heartbeatMs: 0 }), (error) => error instanceof BootstrapLifecycleLockError && error.code === "ACTIVE_OWNER");
    const other = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 115, operation: "finalize", heartbeatMs: 0 });
    await other.release();
    await first.release();
  } finally { await f.cleanup(); }
});

test("shared-kernel lifecycle operations are valid lock owners", async () => {
  const f = await fixture();
  try {
    for (const operation of ["bootstrap", "explicit", "auto", "monitor"] as const) {
      const lock = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 150, operation, phase: "worker", heartbeatMs: 0 });
      await assert.rejects(() => acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 150, operation: "finalize", heartbeatMs: 0 }), (error) => error instanceof BootstrapLifecycleLockError && error.code === "ACTIVE_OWNER" && error.message.includes(`active ${operation} owner`));
      await lock.release();
    }
  } finally { await f.cleanup(); }
});

test("atomic acquisition lets exactly one simultaneous contender win", async () => {
  const f = await fixture();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 200, operation: "self-host", heartbeatMs: 0 })));
    const wins = attempts.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBootstrapLifecycleLock>>> => r.status === "fulfilled");
    assert.equal(wins.length, 1);
    assert.equal(attempts.filter((r) => r.status === "rejected").length, 11);
    await wins[0]!.value.release();
  } finally { await f.cleanup(); }
});

test("heartbeat and phase update retain ownership", async () => {
  const f = await fixture();
  try {
    const lock = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 300, operation: "self-host", heartbeatMs: 0 });
    assert.equal(await git(f.root, "status", "--porcelain"), "");
    await lock.update("verification");
    const raw = await readFile(join(f.root, ".git", "pi-next", "bootstrap-lifecycle", "issue-300.lock", "owner.json"), "utf8");
    assert.equal(JSON.parse(raw).phase, "verification");
    await assert.rejects(() => acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 300, operation: "finalize", heartbeatMs: 0 }), /active self-host owner/);
    await lock.release();
  } finally { await f.cleanup(); }
});

test("dead-owner stale lock can be recovered but malformed lock fails closed", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, ".git", "pi-next", "bootstrap-lifecycle", "issue-400.lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "owner.json"), JSON.stringify({ version: 1, issueNumber: 400, runId: "dead", pid: 99999999, operation: "self-host", phase: "worker", startedAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), cwd: f.root }));
    const recovered = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 400, operation: "finalize", heartbeatMs: 0 });
    await recovered.release();
    const badDir = join(f.root, ".git", "pi-next", "bootstrap-lifecycle", "issue-401.lock");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "owner.json"), "{not-json");
    await assert.rejects(() => acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 401, operation: "finalize", heartbeatMs: 0 }), (error) => error instanceof BootstrapLifecycleLockError && error.code === "AMBIGUOUS_OWNER");
  } finally { await f.cleanup(); }
});

test("active self-host lock blocks finalizer before mutating commands", async () => {
  const f = await fixture();
  try {
    const lock = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 500, operation: "self-host", phase: "worker", heartbeatMs: 0 });
    const commands: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      commands.push([command, ...args].join(" "));
      const { stdout, stderr } = await exec(command, args, { cwd: options.cwd, encoding: "utf8" }).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }));
      return { command, args, cwd: options.cwd, exitCode: stderr ? 1 : 0, stdout, stderr };
    };
    await assert.rejects(() => runBootstrapFinalize({ cwd: f.root, issueNumber: 500, runCommand: runner }), (error) => error instanceof BootstrapLifecycleLockError && error.code === "ACTIVE_OWNER");
    assert.deepEqual(commands, [`git -C ${f.root} rev-parse --show-toplevel`, `git -C ${f.root} rev-parse --path-format=absolute --git-common-dir`]);
    await lock.release();
  } finally { await f.cleanup(); }
});

test("self-host lifecycle blocks before worker/model launch and retained lock is passed to automatic finalizer", async () => {
  const f = await fixture();
  try {
    const active = await acquireBootstrapLifecycleLock({ root: f.root, issueNumber: 600, operation: "finalize", heartbeatMs: 0 });
    let launched = 0;
    await assert.rejects(() => runBootstrapLifecycle({ cwd: f.root, issueNumber: 600, allowRepair: false, review: false, finalize: false }, {}, async () => { launched += 1; return report(600); }), (error) => error instanceof BootstrapLifecycleLockError && error.code === "ACTIVE_OWNER");
    assert.equal(launched, 0);
    await active.release();

    let sawLock = false;
    const lifecycle = await runBootstrapLifecycle({ cwd: f.root, issueNumber: 600, allowRepair: false, review: false, finalize: true }, { runFinalizer: async (input) => { sawLock = !!input.lifecycleLock; return { ok: true, issueNumber: 600, branch: "agent/issue-600", candidateSha: "0".repeat(40), merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, localMainSync: { status: "fast-forwarded", before: "0".repeat(40), after: "1".repeat(40) }, outcome: "finalized" }; } }, async () => report(600));
    assert.equal(lifecycle.finalization, "PASS");
    assert.equal(lifecycle.finalizationReport?.localMainSync?.status, "fast-forwarded");
    assert.equal(sawLock, true);
  } finally { await f.cleanup(); }
});

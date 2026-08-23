import { existsSync, readFileSync } from "node:fs";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { extractCommitEvidenceShas } from "./acceptance-verification";
import { changeFiles, conflictFiles, stagedFiles, workingFingerprint } from "./change-state";
import { failureReasonCode, recordLifecycleEvent } from "./lifecycle-telemetry";
import { recordPiLifecycleJournal } from "./lifecycle-journal.ts";
import { syncProjectStatus, type ProjectStatusAuthority } from "./project-status";
import { commitsReachableFromRef, formatUnreachableCommitDetails } from "./util-core";
import { issueWorkspaceIdentity } from "./issue-authority.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function gitMutation(cwd: string, args: string[]): Promise<string> {
  return git(cwd, args);
}

function journalCwd(cwd: string): string {
  return process.env.PI_NEXT_COORDINATION_CWD?.trim() || cwd;
}

async function hasOrigin(cwd: string): Promise<boolean> {
  return git(cwd, ["remote", "get-url", "origin"])
    .then(() => true)
    .catch(() => false);
}

async function assertPublishedMain(cwd: string): Promise<void> {
  if (!(await hasOrigin(cwd))) return;
  await gitMutation(cwd, ["fetch", "origin", "main"]);
  const [localMain, remoteMain] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["rev-parse", "refs/remotes/origin/main"]),
  ]);
  const localIsAncestor = await git(cwd, ["merge-base", "--is-ancestor", localMain, remoteMain])
    .then(() => true)
    .catch(() => false);
  if (!localIsAncestor) {
    throw new Error(
      "Refusing to create a checkpoint from unpublished or mixed local main history; reconcile main first",
    );
  }
}

async function remoteCheckpointRef(cwd: string, branch: string): Promise<string | undefined> {
  if (!(await hasOrigin(cwd))) return undefined;
  const remote = await git(cwd, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (!remote) return undefined;
  await gitMutation(cwd, ["fetch", "origin", branch]);
  return `refs/remotes/origin/${branch}`;
}

function safePath(path: string): string {
  const value = path.trim().replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value === ".." || value.startsWith("../") || value.includes("/../") || /[*?\\[\\]{}]/.test(value)) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return value;
}

async function commitExplicitPaths(cwd: string, paths: string[], message: string): Promise<string> {
  const normalized = paths.map(safePath);
  await gitMutation(cwd, ["add", "--", ...normalized]);
  await gitMutation(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

const BRANCH_PREFIX = "agent/issue-";

/**
 * Checkpoints share the leased issue branch. Run IDs remain caller metadata;
 * they must still be present and branch-safe, but never create a competing
 * issue identity.
 */
export function checkpointBranchName(issueNumber: number, runId: string): string {
  const identity = issueWorkspaceIdentity(issueNumber);
  const normalizedRun = runId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalizedRun) throw new Error("runId must contain a branch-safe identifier");
  if (normalizedRun.length > 200) throw new Error("runId produces an excessively long checkpoint branch");
  return identity.branch;
}

export async function assertCleanGitState(cwd: string, allowUnstaged = false): Promise<void> {
  const [files, conflicts, staged] = await Promise.all([
    changeFiles(cwd, "all"),
    conflictFiles(cwd),
    stagedFiles(cwd),
  ]);
  if (conflicts.length) throw new Error(`Cannot checkpoint with conflicts: ${conflicts.join(", ")}`);
  if (staged.length) throw new Error(`Cannot checkpoint with pre-staged changes: ${staged.join(", ")}`);
  if (!allowUnstaged && files.length) throw new Error(`Cannot promote with a dirty worktree: ${files.join(", ")}`);
}

export async function ensureCheckpointBranch(
  cwd: string,
  issueNumber: number,
  runId: string,
): Promise<string> {
  const branch = checkpointBranchName(issueNumber, runId);
  const current = await git(cwd, ["branch", "--show-current"]);
  if (current === branch) {
    recordLifecycleEvent(cwd, {
      event: "checkpoint_recovered",
      issueNumber,
      runId,
      branch,
      outcome: "recovered",
    });
    return branch;
  }
  if (current === "main" || current === "master") {
    await assertCleanGitState(cwd, true);
    await assertPublishedMain(cwd);
  } else if (current && current !== branch) {
    throw new Error(`Refusing to switch from unrelated branch ${current}`);
  }
  const exists = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true).catch(() => false);
  const remoteRef = exists ? undefined : await remoteCheckpointRef(cwd, branch);
  if (exists) {
    await gitMutation(cwd, ["switch", branch]);
    recordLifecycleEvent(cwd, {
      event: "checkpoint_recovered",
      issueNumber,
      runId,
      branch,
      outcome: "recovered",
    });
  } else if (remoteRef) {
    await gitMutation(cwd, ["switch", "-c", branch, "--track", `origin/${branch}`]);
    recordLifecycleEvent(cwd, {
      event: "checkpoint_recovered",
      issueNumber,
      runId,
      branch,
      outcome: "recovered",
    });
  } else {
    await gitMutation(cwd, ["switch", "-c", branch]);
  }
  return branch;
}

export async function checkpointCommit(
  cwd: string,
  issueNumber: number,
  runId: string,
  paths: string[],
  message: string,
): Promise<{ branch: string; hash: string }> {
  const branch = await ensureCheckpointBranch(cwd, issueNumber, runId);
  const current = await git(cwd, ["branch", "--show-current"]);
  if (current === "main" || current === "master") throw new Error("Checkpoint commits cannot target the production branch");
  const hash = await commitExplicitPaths(cwd, paths, message);
  if (!hash) throw new Error("Checkpoint produced no commit");
  const candidateSha = await git(cwd, ["rev-parse", "HEAD"]);
  await gitMutation(cwd, ["push", "--set-upstream", "origin", `${branch}:${branch}`]);
  recordPiLifecycleJournal(journalCwd(cwd), {
    event: "candidate_committed",
    issueNumber,
    runId,
    idempotencyKey: `candidate:${issueNumber}:${candidateSha}`,
    payload: { branch, candidateSha },
  });
  recordLifecycleEvent(cwd, {
    event: "checkpoint_pushed",
    issueNumber,
    runId,
    branch,
    outcome: "success",
  });
  return { branch, hash };
}

export async function promotionReadiness(
  cwd: string,
  issueNumber: number,
  runId: string,
  expectedMainSha: string,
  verificationPath: string,
): Promise<{ branch: string; checkpointSha: string; mainSha: string; fingerprint: string }> {
  const branch = checkpointBranchName(issueNumber, runId);
  const current = await git(cwd, ["branch", "--show-current"]);
  if (current !== branch) throw new Error(`Promotion must start on checkpoint branch ${branch}`);
  await assertCleanGitState(cwd);
  await gitMutation(cwd, ["fetch", "origin", "main"]);
  const mainSha = await git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
  if (mainSha !== expectedMainSha) throw new Error("main changed since checkpoint work began; reconcile and reverify before promotion");
  if (!existsSync(verificationPath)) throw new Error(`Verification evidence not found at ${verificationPath}`);
  const verification = readFileSync(verificationPath, "utf8");
  if (!/^STATUS:\s*PASS$/m.test(verification)) throw new Error("Promotion requires PASS verification evidence");
  const checkpointSha = await git(cwd, ["rev-parse", "HEAD"]);
  const fingerprint = await workingFingerprint(cwd);
  const recordedFingerprint = verification.match(/^FINGERPRINT:\s*(\S+)$/m)?.[1];
  if (recordedFingerprint !== fingerprint) throw new Error("Verification evidence is stale for the checkpoint head");
  const evidenceCommitShas = extractCommitEvidenceShas(verification);
  if (evidenceCommitShas.length) {
    const reachability = await commitsReachableFromRef(cwd, evidenceCommitShas, branch);
    if (reachability.unreachable.length) {
      throw new Error(
        `Cannot promote because cited commit evidence is not reachable from checkpoint branch ${branch}:\n${formatUnreachableCommitDetails(reachability.unreachableDetails)}`,
      );
    }
  }
  return { branch, checkpointSha, mainSha, fingerprint };
}

export async function promoteCheckpoint(
  cwd: string,
  issueNumber: number,
  runId: string,
  expectedMainSha: string,
  verificationPath: string,
  lifecycle: { projectStatus?: ProjectStatusAuthority } = {},
): Promise<{ branch: string; mergeSha: string }> {
  const branch = checkpointBranchName(issueNumber, runId);
  try {
    const ready = await promotionReadiness(cwd, issueNumber, runId, expectedMainSha, verificationPath);
    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "promotion_started",
      issueNumber,
      runId,
      idempotencyKey: `promotion-started:${issueNumber}:${ready.checkpointSha}:${ready.mainSha}`,
      payload: { branch: ready.branch, candidateSha: ready.checkpointSha, mainSha: ready.mainSha },
    });
    const localMain = await git(cwd, ["rev-parse", "refs/heads/main"]).catch(() => "");
    if (localMain !== ready.mainSha) {
      await gitMutation(cwd, ["switch", "main"]);
      await gitMutation(cwd, ["merge", "--ff-only", "refs/remotes/origin/main"]);
    } else {
      await gitMutation(cwd, ["switch", "main"]);
    }
    const currentMain = await git(cwd, ["rev-parse", "HEAD"]);
    if (currentMain !== ready.mainSha) throw new Error("Local main is not the freshly fetched main; refusing promotion");
    await gitMutation(cwd, ["merge", "--no-ff", "--no-edit", ready.branch]);
    await gitMutation(cwd, ["push", "origin", "main:main"]);
    const mergeSha = await git(cwd, ["rev-parse", "HEAD"]);
    await gitMutation(cwd, ["fetch", "origin", "main"]);
    const remoteMainSha = await git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
    await git(cwd, ["merge-base", "--is-ancestor", ready.checkpointSha, "refs/remotes/origin/main"]);
    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "promotion_succeeded",
      issueNumber,
      runId,
      idempotencyKey: `promotion-succeeded:${issueNumber}:${ready.checkpointSha}:${mergeSha}`,
      payload: { branch: ready.branch, candidateSha: ready.checkpointSha, mergeSha, mainSha: remoteMainSha },
    });
    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "reachability_proven",
      issueNumber,
      runId,
      idempotencyKey: `reachable:${issueNumber}:${ready.checkpointSha}:${remoteMainSha}`,
      payload: { candidateSha: ready.checkpointSha, mainSha: remoteMainSha },
    });
    if (lifecycle.projectStatus) {
      await syncProjectStatus(cwd, lifecycle.projectStatus, {
        issueNumber,
        status: "Done",
        runId,
        branch,
      });
    }
    recordLifecycleEvent(cwd, {
      event: "promotion_succeeded",
      issueNumber,
      runId,
      branch,
      outcome: "success",
      deployRelevant: true,
    });
    return { branch, mergeSha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordLifecycleEvent(cwd, {
      event: "promotion_failed",
      issueNumber,
      runId,
      branch,
      outcome: "failure",
      reasonCode: failureReasonCode(message),
    });
    throw error;
  }
}

export const checkpointBranchPrefix = BRANCH_PREFIX;

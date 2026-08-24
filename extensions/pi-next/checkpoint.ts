import { existsSync, readFileSync } from "node:fs";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { extractCommitEvidenceShas } from "./acceptance-verification";
import { changeFiles, conflictFiles, stagedFiles, workingFingerprint } from "./change-state";
import { failureReasonCode, recordLifecycleEvent } from "./lifecycle-telemetry";
import { recordPiLifecycleJournal } from "./lifecycle-journal.ts";
import { emitLifecycleCheckpoint } from "../../src/coordination/lifecycle-checkpoints.ts";
import { syncProjectStatus, type ProjectStatusAuthority } from "./project-status";
import { commitsReachableFromRef, formatUnreachableCommitDetails } from "./util-core";
import { issueWorkspaceIdentity } from "./issue-authority.ts";
import { clearPromotionRequest, readPromotionRequest, writePromotionRequest } from "./promotion-request.ts";
import { FinalizeError } from "../../src/coordination/finalize.ts";
import { finalizeWithPostIntegrationReverification } from "../../src/coordination/post-integration-reverification.ts";
import type { IssueLeaseAuthority } from "../../src/coordination/issue-leases.ts";
import type { WorkAuthorityAdapter } from "../../src/coordination/work-authority.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function commandRunner(command: string, args: string[], options: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
  }
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

async function commitExplicitPaths(cwd: string, paths: string[], message: string): Promise<string | undefined> {
  const normalized = paths.map(safePath);
  await gitMutation(cwd, ["add", "--", ...normalized]);
  const hasStagedChanges = await git(cwd, ["diff", "--cached", "--quiet", "--", ...normalized])
    .then(() => false)
    .catch(() => true);
  if (!hasStagedChanges) return undefined;
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
  emitLifecycleCheckpoint("candidate_committed", "before");
  const committedHash = await commitExplicitPaths(cwd, paths, message);
  const hash = committedHash ?? (await git(cwd, ["rev-parse", "--short", "HEAD"]));
  if (!hash) throw new Error("Checkpoint produced no commit");
  const candidateSha = await git(cwd, ["rev-parse", "HEAD"]);
  recordPiLifecycleJournal(journalCwd(cwd), {
    event: "candidate_committed",
    issueNumber,
    runId,
    idempotencyKey: `candidate:${issueNumber}:${candidateSha}`,
    payload: { branch, candidateSha },
  }, { emitCheckpoint: false });
  emitLifecycleCheckpoint("candidate_committed", "after");
  emitLifecycleCheckpoint("candidate_pushed", "before");
  await gitMutation(cwd, ["push", "--set-upstream", "origin", `${branch}:${branch}`]);
  recordPiLifecycleJournal(journalCwd(cwd), {
    event: "candidate_pushed",
    issueNumber,
    runId,
    idempotencyKey: `candidate-pushed:${issueNumber}:${candidateSha}`,
    payload: { branch, candidateSha },
  }, { emitCheckpoint: false });
  emitLifecycleCheckpoint("candidate_pushed", "after");
  recordLifecycleEvent(cwd, {
    event: "checkpoint_pushed",
    issueNumber,
    runId,
    branch,
    outcome: "success",
  });
  return { branch, hash };
}

function verifiedAuthorityFingerprintFromReport(report: string): string {
  const fingerprint = report.match(/^ISSUE_FINGERPRINT:\s*(\S+)$/m)?.[1];
  if (!fingerprint || fingerprint === "unverified") {
    throw new Error("Promotion requires verification evidence bound to a live issue/comments fingerprint");
  }
  if (!/^AUTHORITY_STATUS:\s*VERIFIED$/m.test(report)) {
    throw new Error("Promotion requires verification evidence from a live authority check");
  }
  return fingerprint;
}

export async function promotionReadiness(
  cwd: string,
  issueNumber: number,
  runId: string,
  expectedMainSha: string,
  verificationPath: string,
): Promise<{ branch: string; checkpointSha: string; mainSha: string; fingerprint: string; verifiedAuthorityFingerprint: string }> {
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
  const verifiedAuthorityFingerprint = verifiedAuthorityFingerprintFromReport(verification);
  const evidenceCommitShas = extractCommitEvidenceShas(verification);
  if (evidenceCommitShas.length) {
    const reachability = await commitsReachableFromRef(cwd, evidenceCommitShas, branch);
    if (reachability.unreachable.length) {
      throw new Error(
        `Cannot promote because cited commit evidence is not reachable from checkpoint branch ${branch}:\n${formatUnreachableCommitDetails(reachability.unreachableDetails)}`,
      );
    }
  }
  return { branch, checkpointSha, mainSha, fingerprint, verifiedAuthorityFingerprint };
}

/**
 * Worker-callable: records a durable request to promote the checkpoint
 * branch, after confirming the same STATUS:PASS/fingerprint/commit-evidence
 * readiness `promotionReadiness()` always required. Performs no git mutation
 * of `main` - the worker no longer merges or pushes main directly (#146);
 * `finalizeRequestedPromotion()` is the controller-side step that does.
 */
/**
 * Shared tail of every worker-side finalization request (checkpoint
 * promotion and, since #146, archive completion): writes the durable
 * promotion-request marker `finalizeRequestedPromotion()` resolves, and
 * emits the same journal/checkpoint/telemetry events either caller needs.
 * The marker format and controller-side resolution are intentionally one
 * mechanism for both request origins - see requestArchiveFinalization()
 * below.
 */
async function recordPromotionRequest(
  cwd: string,
  issueNumber: number,
  runId: string,
  branch: string,
  checkpointSha: string,
  mainSha: string,
  fingerprint: string,
  verifiedAuthorityFingerprint: string,
): Promise<void> {
  const gitCommonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  emitLifecycleCheckpoint("promotion_requested", "before");
  await writePromotionRequest({ gitCommonDir, issueNumber, runId, branch, checkpointSha, mainSha, fingerprint, verifiedAuthorityFingerprint });
  recordPiLifecycleJournal(journalCwd(cwd), {
    event: "promotion_requested",
    issueNumber,
    runId,
    idempotencyKey: `promotion-requested:${issueNumber}:${checkpointSha}:${mainSha}`,
    payload: { branch, candidateSha: checkpointSha, mainSha },
  }, { emitCheckpoint: false });
  emitLifecycleCheckpoint("promotion_requested", "after");
  recordLifecycleEvent(cwd, { event: "promotion_requested", issueNumber, runId, branch, outcome: "success" });
}

export async function requestPromotion(
  cwd: string,
  issueNumber: number,
  runId: string,
  expectedMainSha: string,
  verificationPath: string,
): Promise<{ branch: string; checkpointSha: string }> {
  const branch = checkpointBranchName(issueNumber, runId);
  try {
    const ready = await promotionReadiness(cwd, issueNumber, runId, expectedMainSha, verificationPath);
    await recordPromotionRequest(cwd, issueNumber, runId, ready.branch, ready.checkpointSha, ready.mainSha, ready.fingerprint, ready.verifiedAuthorityFingerprint);
    return { branch: ready.branch, checkpointSha: ready.checkpointSha };
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

/**
 * Worker-callable: records a durable finalization request for an already-
 * created archive commit (see extensions/pi-next/commit-safety.ts's
 * archiveAndCommit), reusing the exact promotion-request marker and
 * controller-side resolution (finalizeRequestedPromotion -> finalizeIssue())
 * checkpoint promotion already uses. Unifies the two prior separate
 * completion paths (#146): the worker no longer pushes to main or closes
 * the issue on either path - only the controller does, via one finalizer.
 * `checkpointSha` here is the archive commit's own hash, not a checkpoint
 * branch tip; `checkpointBranchName()` returns the shared leased issue
 * branch regardless of origin, so both request kinds land on the same
 * `agent/issue-N` branch finalizeIssue() expects.
 */
export async function requestArchiveFinalization(
  cwd: string,
  issueNumber: number,
  runId: string,
  archiveCommitSha: string,
  verifiedAuthorityFingerprint: string,
): Promise<{ branch: string; checkpointSha: string }> {
  const branch = checkpointBranchName(issueNumber, runId);
  try {
    await gitMutation(cwd, ["fetch", "origin", "main"]);
    const mainSha = await git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
    const fingerprint = await workingFingerprint(cwd);
    await recordPromotionRequest(cwd, issueNumber, runId, branch, archiveCommitSha, mainSha, fingerprint, verifiedAuthorityFingerprint);
    return { branch, checkpointSha: archiveCommitSha };
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

/**
 * Controller-callable: resolves a pending `requestPromotion()` record (if
 * any) by calling the canonical `finalizeIssue()` kernel primitive
 * (src/coordination/finalize.ts) - the merge/push/reachability/authority-
 * close sequence the worker itself no longer performs. `cwd` must be the
 * coordination root checked out on `main` (finalizeIssue()'s own
 * invariant), not the worker's issue worktree. Returns `undefined` when no
 * promotion is pending, so callers can treat it as a no-op check.
 */
export async function finalizeRequestedPromotion(
  cwd: string,
  issueNumber: number,
  leaseAuthority: IssueLeaseAuthority,
  workAuthority: WorkAuthorityAdapter,
  identity: { agent: string; runId: string; sessionId: string },
  lifecycle: { projectStatus?: ProjectStatusAuthority } = {},
): Promise<{ branch: string; mergeSha: string; closed: boolean; authorityChanged: boolean; requiresReverification: boolean } | undefined> {
  const gitCommonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const request = await readPromotionRequest(gitCommonDir, issueNumber);
  if (!request) return undefined;

  try {
    const issue = await workAuthority.get(String(issueNumber));
    const finalizeInput = {
      cwd,
      issueNumber,
      agent: identity.agent,
      runId: identity.runId,
      sessionId: identity.sessionId,
      candidateSha: request.checkpointSha,
      issueUpdatedAt: issue.updatedAt ?? "",
      verifiedAuthorityFingerprint: request.verifiedAuthorityFingerprint,
    };
    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "promotion_started",
      issueNumber,
      runId: identity.runId,
      idempotencyKey: `promotion-started:${issueNumber}:${request.checkpointSha}:${request.mainSha}`,
      payload: { branch: request.branch, candidateSha: request.checkpointSha, mainSha: request.mainSha },
    });
    const recovery = await finalizeWithPostIntegrationReverification({
      leaseAuthority,
      workAuthority,
      finalizeInput,
      gitCommonDir,
      runCommand: commandRunner,
    });
    if (recovery.status === "verification-failed") {
      throw new Error(`${recovery.failedCheck.command} failed during post-integration reverification of ${recovery.mergeSha}: ${recovery.failedCheck.stderr || recovery.failedCheck.stdout || "no output"}`);
    }
    if (recovery.status === "requires-reverification") {
      throw new Error(`origin/main advanced with unrelated commits during finalize; re-verify against current main (mergeSha=${recovery.mergeSha}) before retrying`);
    }
    const result = recovery.result;

    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "promotion_succeeded",
      issueNumber,
      runId: identity.runId,
      idempotencyKey: `promotion-succeeded:${issueNumber}:${request.checkpointSha}:${result.mergeSha}`,
      payload: { branch: request.branch, candidateSha: request.checkpointSha, mergeSha: result.mergeSha, mainSha: result.mergeSha },
    });
    recordPiLifecycleJournal(journalCwd(cwd), {
      event: "reachability_proven",
      issueNumber,
      runId: identity.runId,
      idempotencyKey: `reachable:${issueNumber}:${request.checkpointSha}:${result.mergeSha}`,
      payload: { candidateSha: request.checkpointSha, mainSha: result.mergeSha },
    });
    await clearPromotionRequest(gitCommonDir, issueNumber);
    if (result.closed && lifecycle.projectStatus) {
      await syncProjectStatus(cwd, lifecycle.projectStatus, {
        issueNumber,
        status: "Done",
        runId: identity.runId,
        branch: request.branch,
      });
    }
    recordLifecycleEvent(cwd, {
      event: "promotion_finalized",
      issueNumber,
      runId: identity.runId,
      branch: request.branch,
      outcome: "success",
      deployRelevant: result.closed,
    });
    return {
      branch: request.branch,
      mergeSha: result.mergeSha,
      closed: result.closed,
      authorityChanged: result.authorityChanged,
      requiresReverification: result.requiresReverification,
    };
  } catch (error) {
    const message = error instanceof FinalizeError ? error.message : error instanceof Error ? error.message : String(error);
    recordLifecycleEvent(cwd, {
      event: "promotion_failed",
      issueNumber,
      runId: identity.runId,
      branch: request.branch,
      outcome: "failure",
      reasonCode: failureReasonCode(message),
    });
    throw error;
  }
}

export const checkpointBranchPrefix = BRANCH_PREFIX;

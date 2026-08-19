import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { git, planFile, verifyFile } from "./util.ts";

export interface MainRefreshResult {
  branch: string;
  before: string;
  remote: string;
  after: string;
  aheadBy: number;
  behindBy: number;
  updated: boolean;
  healed: boolean;
  skippedDirty?: boolean;
}

export class IssueWorkspaceCleanupError extends Error {
  readonly code = "issue_workspace_cleanup_failed";

  constructor(message: string) {
    super(message);
    this.name = "IssueWorkspaceCleanupError";
  }
}

function parseAheadBehind(value: string): { aheadBy: number; behindBy: number } {
  const [aheadRaw = "0", behindRaw = "0"] = value.trim().split(/\s+/);
  const aheadBy = Number.parseInt(aheadRaw, 10);
  const behindBy = Number.parseInt(behindRaw, 10);
  return {
    aheadBy: Number.isFinite(aheadBy) ? aheadBy : 0,
    behindBy: Number.isFinite(behindBy) ? behindBy : 0,
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function refreshLockFile(cwd: string): Promise<string> {
  const commonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
  return resolve(cwd, commonDir, "pi-next-main-refresh.lock");
}

async function acquireRefreshLock(cwd: string): Promise<() => void> {
  const lock = await refreshLockFile(cwd);
  mkdirSync(dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
      closeSync(fd);
      return () => {
        if (existsSync(lock)) unlinkSync(lock);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let pid = 0;
      try {
        pid = Number.parseInt(readFileSync(lock, "utf8").match(/^pid=(\d+)$/m)?.[1] || "0", 10);
      } catch {
        // A concurrently released lock will simply be retried below.
      }
      if (pid > 0 && !processAlive(pid)) {
        try { unlinkSync(lock); } catch { /* another contender recovered it */ }
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error("Timed out waiting for another local controller to finish refreshing main");
}

/**
 * Refresh shared main only at the clean no-PLAN issue boundary.
 *
 * This deliberately performs no merge/rebase on an active issue branch. The
 * next issue must start from the latest published main, while in-progress work
 * keeps its stable checkpoint/worktree until the normal promotion gate
 * reconciles it against main.
 *
 * Self-heal safety boundary: ahead-only local drift (local main has
 * unpublished commits and origin/main has not moved) is self-healed with a
 * plain fast-forward `git push origin main`. This is safe because origin/main
 * remains a strict ancestor of local main, so publishing it rewrites nothing
 * and cannot lose data. If that push itself races another agent's publish, we
 * re-fetch and recompute rather than force-pushing or swallowing the error.
 *
 * Diverged drift (local main has unpublished commits *and* origin/main has
 * commits local hasn't seen) is never self-healed. Reconciling it would
 * require an unattended merge or rebase decision — including which side wins
 * a conflict — that is not safe to make automatically, so this function keeps
 * throwing and requires explicit human/agent reconciliation.
 */
export async function refreshMainAtIssueBoundary(
  cwd: string,
  onStatus?: (message: string) => void,
): Promise<MainRefreshResult> {
  const release = await acquireRefreshLock(cwd);
  try {
    const branch = await git(cwd, ["branch", "--show-current"]);
    if (branch !== "main") {
      throw new Error(
        `Cannot select a new issue from ${branch || "detached HEAD"}; refresh requires the main checkout`,
      );
    }

    const dirty = await git(cwd, ["status", "--porcelain"]);
    if (dirty.trim()) {
      // The coordination checkout may be shared with another agent. Issue
      // selection only needs live GitHub state; the claimed issue worktree is
      // created from origin/main and must not be blocked by unrelated changes
      // in this checkout.
      onStatus?.("Main checkout is busy; leaving it untouched and continuing in the issue worktree");
      const before = await git(cwd, ["rev-parse", "HEAD"]);
      return {
        branch,
        before,
        remote: before,
        after: before,
        aheadBy: 0,
        behindBy: 0,
        updated: false,
        healed: false,
        skippedDirty: true,
      };
    }

    onStatus?.("Refreshing main from origin before issue selection");
    await git(cwd, ["fetch", "origin", "main"]);
    const before = await git(cwd, ["rev-parse", "HEAD"]);
    const remote = await git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
    const counts = parseAheadBehind(
      await git(cwd, [
        "rev-list",
        "--left-right",
        "--count",
        `${before}...${remote}`,
      ]),
    );

    if (counts.aheadBy > 0 && counts.behindBy > 0) {
      throw new Error(
        `Local main diverged from origin/main (ahead ${counts.aheadBy}, behind ${counts.behindBy}); reconcile explicitly before selecting another issue`,
      );
    }
    let healed = false;
    if (counts.aheadBy > 0) {
      try {
        await git(cwd, ["push", "origin", "main"]);
        healed = true;
      } catch {
        // Another agent may have published to origin/main between our fetch
        // and this push, making it non-fast-forward. Re-fetch and recompute
        // ahead/behind against the now-current origin/main instead of
        // swallowing the failure or force-pushing over the other agent's work.
        await git(cwd, ["fetch", "origin", "main"]);
        const raceRemote = await git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
        const raceCounts = parseAheadBehind(
          await git(cwd, [
            "rev-list",
            "--left-right",
            "--count",
            `${before}...${raceRemote}`,
          ]),
        );

        if (raceCounts.aheadBy > 0 && raceCounts.behindBy > 0) {
          throw new Error(
            `Local main diverged from origin/main (ahead ${raceCounts.aheadBy}, behind ${raceCounts.behindBy}); reconcile explicitly before selecting another issue`,
          );
        }

        throw new Error(
          `Local main could not be published to origin/main because another agent pushed to origin/main first (behind ${raceCounts.behindBy}); reconcile explicitly before selecting another issue`,
        );
      }
    }

    if (counts.behindBy > 0) {
      await git(cwd, ["merge", "--ff-only", "refs/remotes/origin/main"]);
    }
    const after = await git(cwd, ["rev-parse", "HEAD"]);
    return {
      branch,
      before,
      remote,
      after,
      aheadBy: 0,
      behindBy: counts.behindBy,
      updated: after !== before,
      healed,
    };
  } finally {
    release();
  }
}

/**
 * Remove only a completed issue's disposable local checkout. The canonical
 * branch remains remote/recoverable; local removal is allowed only after the
 * expected path, branch identity, clean boundary, and absence of active
 * PLAN/VERIFY artifacts have all been proven.
 */
export async function cleanupCompletedIssueWorktree(
  coordinationCwd: string,
  workspaceCwd: string,
  issueNumber: number,
): Promise<void> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new IssueWorkspaceCleanupError("issueNumber must be a positive integer");
  }
  const expectedPath = resolve(
    coordinationCwd,
    ".worktrees",
    `issue-${issueNumber}`,
  );
  const expectedBranch = `agent/issue-${issueNumber}`;
  const actualPath = resolve(workspaceCwd);
  if (actualPath !== expectedPath) {
    throw new IssueWorkspaceCleanupError(
      `refusing cleanup for unexpected issue workspace ${workspaceCwd}; expected ${expectedPath}`,
    );
  }
  if (actualPath === resolve(coordinationCwd)) {
    throw new IssueWorkspaceCleanupError(
      "refusing to remove the coordination checkout as an issue workspace",
    );
  }

  const registrations = await git(coordinationCwd, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const registered = registrations
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  if (!registered.includes(expectedPath)) {
    throw new IssueWorkspaceCleanupError(
      `issue #${issueNumber} workspace is not registered at ${expectedPath}`,
    );
  }

  const branch = await git(actualPath, ["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new IssueWorkspaceCleanupError(
      `refusing cleanup of ${expectedPath}: found ${branch || "detached HEAD"}, expected ${expectedBranch}`,
    );
  }

  const dirty = await git(actualPath, ["status", "--porcelain"]);
  if (dirty.trim()) {
    throw new IssueWorkspaceCleanupError(
      `issue #${issueNumber} workspace is not clean; preserving recoverable state`,
    );
  }

  const activeArtifacts = [planFile(actualPath), verifyFile(actualPath)].filter((path) => existsSync(path));
  if (activeArtifacts.length) {
    throw new IssueWorkspaceCleanupError(
      `issue #${issueNumber} still has active workflow artifacts: ${activeArtifacts.join(", ")}`,
    );
  }

  await git(coordinationCwd, ["worktree", "remove", expectedPath]);
  await git(coordinationCwd, ["worktree", "prune"]);
}

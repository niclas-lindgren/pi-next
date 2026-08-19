/**
 * Mechanical terminal-completion primitive for canonical `agent/issue-N`
 * branches.
 *
 * Ported from Campsty's `.agents/coordination/finalize.ts` (#619) so any
 * compatible agent harness gets the same guarded sequence instead of a set
 * of optional model-authored shell steps: fetch, switch, merge, push,
 * reachability check, then separately call complete/release. Nothing
 * enforced that sequence or its ordering, so a model could close a work
 * item while the verified candidate commit was never actually reachable
 * from `origin/main`.
 *
 * `finalizeIssue()` makes that sequence one guarded operation:
 *
 *   validate fresh lease ownership
 *   -> validate the exact verified candidate is still agent/issue-N's tip
 *   -> integrate the candidate into main (non-destructive, race-safe)
 *   -> prove the candidate reachable from pushed origin/main
 *   -> re-validate lease ownership
 *   -> re-fetch live work-item authority; close only if unchanged
 *
 * It never merges/pushes if any prior step fails, never force-pushes, and
 * never closes the work item when integration succeeded but authority
 * changed underneath it (the merge still lands -- main integration and
 * closure are allowed to diverge in that case; a stale worker must not
 * silently mark stale-authority work "Done").
 *
 * Unlike Campsty's copy, the close/comment step goes through the injected
 * `WorkAuthorityAdapter` (`work-authority.ts`) instead of hardcoded `gh`
 * calls, so this module stays authority-adapter-agnostic. Git integration
 * itself (merge/push/reachability) has no GitHub dependency and is
 * unchanged. Worktree/branch cleanup remains the caller's separate, later
 * step, exactly like `release` remains separate from `complete`: a partial
 * terminal failure (e.g. push succeeds, close fails) must never destroy
 * recoverable state.
 */

import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import {
  issueLeaseMatchesOwner,
  isIssueLeaseFresh,
  type IssueLease,
} from "./issue-authority.ts";
import type { IssueLeaseAuthority } from "./issue-leases.ts";
import { requireAuthorityCapability, type WorkAuthorityAdapter } from "./work-authority.ts";

const execFileAsync = promisify(execFile);

export type FinalizeErrorCode =
  | "LEASE_LOST"
  | "CANDIDATE_STALE"
  | "UNSAFE_ROOT"
  | "ROOT_BUSY"
  | "PROMOTION_RACE"
  | "STALE_AUTHORITY";

export class FinalizeError extends Error {
  constructor(
    readonly code: FinalizeErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "FinalizeError";
  }
}

export interface FinalizeInput {
  /** The coordination root checkout -- must have `main` checked out; never an issue worktree. */
  cwd: string;
  issueNumber: number;
  agent: string;
  runId: string;
  sessionId: string;
  /** The exact commit that passed final verification; must still be agent/issue-N's tip. */
  candidateSha: string;
  /** The live work item's `updatedAt` at the moment verification was performed. */
  issueUpdatedAt: string;
  /**
   * Required to close a retry after a prior `requiresReverification: true`
   * result (#20): the exact integrated `main` SHA that result reported as
   * `mergeSha`, which the caller re-ran verification against. When this
   * call finds nothing new to integrate (the candidate is already
   * reachable from `origin/main`), candidate reachability alone never
   * proves the *current* `origin/main` tree is the one that was
   * reverified -- another commit may have landed since. If omitted, or if
   * it no longer matches the live integrated main this call observes,
   * closure is refused and `requiresReverification: true` is returned
   * again with the new state to verify.
   */
  verifiedIntegratedMain?: string;
  closeComment?: string;
}

export interface FinalizeResult {
  ok: true;
  issueNumber: number;
  branch: string;
  mergeSha: string;
  /** False when integration succeeded but the work item was not closed (authority changed, lease lost, or reverification required). */
  closed: boolean;
  authorityChanged: boolean;
  leaseLostAfterMerge: boolean;
  /**
   * True when `origin/main` had already advanced with commits beyond the
   * candidate's own verified base (a real 3-way integration, not a
   * no-op/fast-forward) by the time it merged. The candidate was still
   * verified in isolation on its own branch, not together with those other
   * commits, so the merged tree has no fresh verification evidence. The
   * merge/push still lands durably (main integration isn't held hostage),
   * but the caller must re-run the repository's required verification
   * against the current `main` HEAD and call `finalize` again (same
   * candidate) before the issue can close.
   */
  requiresReverification: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/**
 * Serializes concurrent finalize/refresh attempts against the same
 * coordination root, using a lock file under the shared git-common-dir so
 * it does not depend on any specific extension host.
 */
async function acquireFinalizeLock(cwd: string): Promise<() => void> {
  const gitCommonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
  const lock = resolve(cwd, gitCommonDir, "coordination-finalize.lock");
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
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch {
          try {
            unlinkSync(lock);
          } catch {
            // another contender recovered it first
          }
          continue;
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new FinalizeError("ROOT_BUSY", "Timed out waiting for another finalize to finish");
}

function assertOwnedFreshLease(
  lease: IssueLease | undefined,
  input: Pick<FinalizeInput, "issueNumber" | "agent" | "runId" | "sessionId">,
): void {
  if (
    !lease ||
    !issueLeaseMatchesOwner(lease, input) ||
    !isIssueLeaseFresh(lease, new Date())
  ) {
    throw new FinalizeError(
      "LEASE_LOST",
      `Issue #${input.issueNumber} lease is not freshly owned by agent=${input.agent} run=${input.runId} session=${input.sessionId}`,
    );
  }
}

const MAX_PROMOTION_ATTEMPTS = 3;

export async function finalizeIssue(
  leaseAuthority: IssueLeaseAuthority,
  workAuthority: WorkAuthorityAdapter,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  requireAuthorityCapability(workAuthority, "completion");

  const branch = `agent/issue-${input.issueNumber}`;

  assertOwnedFreshLease(await leaseAuthority.read(input.issueNumber), input);

  const rootBranch = await git(input.cwd, ["branch", "--show-current"]);
  if (rootBranch !== "main") {
    throw new FinalizeError(
      "UNSAFE_ROOT",
      `finalize must run from the coordination root with main checked out; found ${rootBranch || "detached HEAD"} at ${input.cwd}`,
    );
  }

  const initialTip = await tryGit(input.cwd, ["rev-parse", branch]);
  if (!initialTip) {
    throw new FinalizeError("CANDIDATE_STALE", `Branch ${branch} was not found in ${input.cwd}`);
  }
  if (initialTip !== input.candidateSha) {
    throw new FinalizeError(
      "CANDIDATE_STALE",
      `${branch}'s tip ${initialTip} no longer matches the verified candidate ${input.candidateSha}; reconcile and re-verify before finalizing`,
    );
  }

  const release = await acquireFinalizeLock(input.cwd);
  let mergeSha: string;
  let requiresReverification = false;
  try {
    const dirty = await git(input.cwd, ["status", "--porcelain"]);
    if (dirty.trim()) {
      throw new FinalizeError(
        "ROOT_BUSY",
        "Coordination checkout is dirty; leaving it untouched. Retry once it is clean.",
      );
    }

    // Establish the candidate's own verified base *before* integrating, so
    // the post-merge check below can tell a genuine 3-way integration (main
    // gained commits the candidate was never verified against) apart from a
    // no-op/fast-forward one. `merge-base` is stable for this purpose only
    // while the candidate isn't yet reachable from main -- once merged (e.g.
    // a retry after a prior call already landed it), the candidate itself
    // becomes its own merge-base with main, which would wrongly look like
    // "no divergence" for a stale comparison. Skip the check entirely in
    // that already-integrated case: this call has nothing new to integrate,
    // so there is nothing new to reverify either.
    await git(input.cwd, ["fetch", "origin", "main"]);
    const remoteMainAtStart = await git(input.cwd, ["rev-parse", "refs/remotes/origin/main"]);
    const candidateAlreadyOnMain =
      (await tryGit(input.cwd, ["merge-base", "--is-ancestor", input.candidateSha, remoteMainAtStart])) !==
      undefined;
    const verifiedBase = candidateAlreadyOnMain
      ? undefined
      : await git(input.cwd, ["merge-base", input.candidateSha, remoteMainAtStart]);
    let integrationBase: string | undefined;

    let pushed = false;
    let lastPushError: unknown;
    for (let attempt = 1; attempt <= MAX_PROMOTION_ATTEMPTS && !pushed; attempt += 1) {
      await git(input.cwd, ["fetch", "origin", "main"]);
      const localMain = await git(input.cwd, ["rev-parse", "HEAD"]);
      const remoteMain = await git(input.cwd, ["rev-parse", "refs/remotes/origin/main"]);

      if (localMain !== remoteMain) {
        const counts = await git(input.cwd, [
          "rev-list",
          "--left-right",
          "--count",
          `${localMain}...${remoteMain}`,
        ]);
        const [aheadRaw = "0"] = counts.split(/\s+/);
        if (Number.parseInt(aheadRaw, 10) > 0) {
          throw new FinalizeError(
            "UNSAFE_ROOT",
            "Local main has unpublished commits ahead of origin/main; reconcile explicitly before finalizing",
          );
        }
        await git(input.cwd, ["merge", "--ff-only", "refs/remotes/origin/main"]);
      }

      // Re-derive the candidate tip on every attempt: the branch could have
      // advanced (or been rewritten) between the pre-lock check and now.
      const currentTip = await tryGit(input.cwd, ["rev-parse", branch]);
      if (currentTip !== input.candidateSha) {
        throw new FinalizeError(
          "CANDIDATE_STALE",
          `${branch} advanced past the verified candidate ${input.candidateSha} during finalize; reconcile and re-verify`,
        );
      }

      // Captured before the merge, from *this* attempt: the base the
      // candidate is actually being integrated against, whichever attempt
      // ends up winning the race below.
      integrationBase = await git(input.cwd, ["rev-parse", "HEAD"]);
      await git(input.cwd, ["merge", "--no-ff", "--no-edit", input.candidateSha]);
      try {
        await git(input.cwd, ["push", "origin", "HEAD:main"]);
        pushed = true;
      } catch (error) {
        lastPushError = error;
        // Another promotion won the race. Undo only our local unpublished
        // merge (never touches origin) and retry against fresh main.
        await git(input.cwd, ["reset", "--hard", localMain]);
      }
    }

    if (!pushed) {
      throw new FinalizeError(
        "PROMOTION_RACE",
        `Could not push main after ${MAX_PROMOTION_ATTEMPTS} attempts; another promotion kept winning the race`,
        { cause: lastPushError instanceof Error ? lastPushError.message : String(lastPushError) },
      );
    }

    mergeSha = await git(input.cwd, ["rev-parse", "HEAD"]);
    await git(input.cwd, ["fetch", "origin", "main"]);
    const reachable = await tryGit(input.cwd, [
      "merge-base",
      "--is-ancestor",
      input.candidateSha,
      "refs/remotes/origin/main",
    ]);
    if (reachable === undefined) {
      throw new FinalizeError(
        "PROMOTION_RACE",
        "Pushed main does not contain the verified candidate commit; refusing to close",
      );
    }

    // #20: when there was nothing new to integrate this call (the candidate
    // was already reachable from origin/main before we started), candidate
    // reachability alone never proves the *current* integrated main tree is
    // the one the caller actually reverified -- another commit may have
    // landed since. Require an exact match against the caller's proof
    // (the `mergeSha` from the `requiresReverification: true` result they
    // verified) rather than treating "nothing to merge" as "nothing to
    // reverify".
    requiresReverification = candidateAlreadyOnMain
      ? input.verifiedIntegratedMain !== mergeSha
      : verifiedBase !== undefined && integrationBase !== verifiedBase;
  } finally {
    release();
  }

  // Integration succeeded and is durable at this point; nothing below may
  // undo it. Whether the work item actually closes depends on whether the
  // integrated tree has fresh verification evidence and the lease/authority
  // are still exactly what was verified.
  if (requiresReverification) {
    return {
      ok: true,
      issueNumber: input.issueNumber,
      branch,
      mergeSha,
      closed: false,
      authorityChanged: false,
      leaseLostAfterMerge: false,
      requiresReverification: true,
    };
  }

  const leaseAfterMerge = await leaseAuthority.read(input.issueNumber);
  const leaseStillOwned =
    !!leaseAfterMerge &&
    issueLeaseMatchesOwner(leaseAfterMerge, input) &&
    isIssueLeaseFresh(leaseAfterMerge, new Date());
  if (!leaseStillOwned) {
    return {
      ok: true,
      issueNumber: input.issueNumber,
      branch,
      mergeSha,
      closed: false,
      authorityChanged: false,
      leaseLostAfterMerge: true,
      requiresReverification: false,
    };
  }

  const item = await workAuthority.get(String(input.issueNumber));
  if ((item.updatedAt ?? "") !== input.issueUpdatedAt) {
    return {
      ok: true,
      issueNumber: input.issueNumber,
      branch,
      mergeSha,
      closed: false,
      authorityChanged: true,
      leaseLostAfterMerge: false,
      requiresReverification: false,
    };
  }

  await workAuthority.close(String(input.issueNumber), input.closeComment ?? "Completed via pi-next automated workflow.");

  return {
    ok: true,
    issueNumber: input.issueNumber,
    branch,
    mergeSha,
    closed: true,
    authorityChanged: false,
    leaseLostAfterMerge: false,
    requiresReverification: false,
  };
}

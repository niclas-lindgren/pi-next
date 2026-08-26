import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireBootstrapLifecycleLock, type BootstrapLifecycleLock } from "../bootstrap/lifecycle-lock.js";
import { invalidateVerifiedFinalizationCandidateProof, readVerifiedFinalizationCandidateProof, writeVerifiedFinalizationCandidateProof } from "../bootstrap/finalization-proof.js";
import { CANONICAL_STATUS_ARGS, changedFilePathsFromStatus, uniqueSortedGitPaths } from "../bootstrap/git-status.js";
import { emitLifecycleCheckpoint } from "../coordination/lifecycle-checkpoints.js";
import { FinalizeError, type PendingVerificationRequest } from "../coordination/finalize.ts";
import { commitIncidentDiagnosticsBeforeFinalization, finalizeWithPostIntegrationReverification } from "../coordination/post-integration-reverification.ts";
import { REQUIRED_CHECKS } from "../coordination/required-checks.ts";
import {
  authorityFingerprint,
  GitHubWorkAuthority,
  isAwaitingExternalVerification,
  pendingVerificationState,
  type AuthorityWorkItem,
  type PendingVerificationCriterion,
  type WorkAuthorityAdapter,
} from "../coordination/work-authority.ts";
import { createIssueLease } from "../coordination/issue-authority.ts";
import type { IssueLease } from "../coordination/issue-authority.ts";
import type { IssueLeaseAuthority } from "../coordination/issue-leases.ts";

const execFileAsync = promisify(execFile);

export interface CommandResult { command: string; args: string[]; cwd: string; exitCode: number; stdout: string; stderr: string; }
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export interface BootstrapFinalizeOptions {
  cwd?: string;
  issueNumber?: number;
  /** Defaults to a real `gh`-backed GitHubWorkAuthority; tests inject InMemoryWorkAuthority. */
  authority?: WorkAuthorityAdapter;
  /** Defaults to a self-owned always-fresh lease: bootstrap's real exclusivity comes from its own BootstrapLifecycleLock, not the leased-ownership model production uses. */
  leaseAuthority?: IssueLeaseAuthority;
  runCommand?: CommandRunner;
  candidatePaths?: string[];
  reporter?: (line: string) => void;
  lifecycleLock?: BootstrapLifecycleLock;
}
export type LocalMainSyncStatus = "fast-forwarded" | "already-current" | "skipped";
export interface LocalMainSyncResult { status: LocalMainSyncStatus; reason?: string; before?: string; after?: string; }
export interface BootstrapFinalizeReport {
  ok: boolean;
  issueNumber: number;
  branch: string;
  candidateSha: string;
  merged: boolean;
  reachable: boolean;
  issueClosed: boolean;
  worktreeRemoved: boolean;
  localBranchRemoved: boolean;
  localMainSync?: LocalMainSyncResult;
  outcome: "finalized" | "already-satisfied" | "integrated-pending-verification" | "integrated-authority-changed";
  pendingExternalVerification?: boolean;
}

export class BootstrapFinalizeError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "BootstrapFinalizeError"; } }

export async function runCommand(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return { command, args, cwd: options.cwd, exitCode: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { command, args, cwd: options.cwd, exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
  }
}

async function gitRaw(cwd: string, args: string[], runner: CommandRunner): Promise<string> {
  const r = await runner("git", ["-C", cwd, ...args], { cwd });
  if (r.exitCode !== 0) throw new BootstrapFinalizeError("GIT_FAILED", `git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
async function git(cwd: string, args: string[], runner: CommandRunner): Promise<string> { return (await gitRaw(cwd, args, runner)).trim(); }
async function tryGit(cwd: string, args: string[], runner: CommandRunner): Promise<string | undefined> { try { return await git(cwd, args, runner); } catch { return undefined; } }
async function sh(cwd: string, command: string, runner: CommandRunner): Promise<void> { const r = await runner("sh", ["-c", command], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("VERIFY_FAILED", `${command} failed: ${(r.stderr || r.stdout).slice(0, 4000)}`); }

interface WorktreeEntry { path: string; branch?: string; }
function parseWorktrees(text: string): WorktreeEntry[] { const out: WorktreeEntry[] = []; let cur: WorktreeEntry | undefined; for (const line of text.split("\n")) { if (line.startsWith("worktree ")) { if (cur) out.push(cur); cur = { path: line.slice(9) }; } else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, ""); } if (cur) out.push(cur); return out; }
function issueFromBranch(branch?: string): number | undefined { const m = branch?.match(/^agent\/issue-(\d+)$/); return m ? Number(m[1]) : undefined; }
function commitMessage(issue: AuthorityWorkItem, issueNumber: number): string { const title = issue.title.trim().replace(/\s+/g, " ").slice(0, 72); return `${title || "bootstrap candidate"} (#${issueNumber})`; }

/**
 * bootstrap's own file-based BootstrapLifecycleLock already guarantees only
 * one process finalizes a given issue at a time, so unlike production's
 * multi-agent lease CAS this is a trivial always-fresh, always-owned lease -
 * finalizeIssue()'s ownership check is satisfied by construction rather than
 * by a real shared store.
 */
class SelfOwnedLeaseAuthority implements IssueLeaseAuthority {
  constructor(private readonly agent: string, private readonly runId: string, private readonly sessionId: string) {}
  async read(issueNumber: number): Promise<IssueLease | undefined> {
    const now = new Date();
    return createIssueLease({
      issueNumber,
      agent: this.agent,
      runId: this.runId,
      sessionId: this.sessionId,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    });
  }
  async create(): Promise<void> { throw new Error("bootstrap finalize owns exclusivity via its own lifecycle lock; lease creation is not supported"); }
  async replace(): Promise<void> { throw new Error("bootstrap finalize owns exclusivity via its own lifecycle lock; lease replacement is not supported"); }
  async remove(): Promise<void> { throw new Error("bootstrap finalize owns exclusivity via its own lifecycle lock; lease removal is not supported"); }
}

type ExternalVerificationGate =
  | { status: "clear" }
  | { status: "pending"; criteria: readonly PendingVerificationCriterion[] }
  | { status: "failed" };

/**
 * Reactive, read-only classification of an issue's *existing* pending-
 * verification comments (posted by a human or an external deploy pipeline
 * before finalize runs) - distinct from finalizeIssue()'s own
 * `pendingVerification` request/record mechanism, which this gate feeds.
 */
function externalVerificationGate(issue: AuthorityWorkItem): ExternalVerificationGate {
  const { pending, result } = pendingVerificationState(issue);
  if (!pending) return { status: "clear" };
  if (isAwaitingExternalVerification(issue)) return { status: "pending", criteria: pending.criteria };
  return result?.status === "failed" ? { status: "failed" } : { status: "clear" };
}

async function discoverIssue(root: string, explicit: number | undefined, runner: CommandRunner): Promise<number> {
  if (explicit !== undefined) return explicit;
  const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner));
  const plausible = new Set<number>();
  const addIfLiveCandidate = async (issue: number, branch: string, worktreePath?: string) => {
    const dirty = worktreePath ? (await gitRaw(worktreePath, [...CANONICAL_STATUS_ARGS], runner)).trimEnd().length > 0 : false;
    const integrated = (await tryGit(root, ["merge-base", "--is-ancestor", branch, "origin/main"], runner)) !== undefined;
    if (dirty || !integrated) plausible.add(issue);
  };
  for (const e of entries) {
    const n = issueFromBranch(e.branch);
    if (n && basename(e.path) === `issue-${n}` && basename(dirname(e.path)) === ".worktrees") await addIfLiveCandidate(n, e.branch!, e.path);
  }
  const branches = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agent/issue-*"], runner).catch(() => "");
  for (const b of branches.split("\n").filter(Boolean)) { const n = issueFromBranch(b); if (n) await addIfLiveCandidate(n, b); }
  if (plausible.size !== 1) throw new BootstrapFinalizeError("AMBIGUOUS_CANDIDATE", `expected one bootstrap candidate, found ${plausible.size}`);
  return [...plausible][0]!;
}

async function resolveRoot(cwd: string, runner: CommandRunner): Promise<string> { return git(cwd, ["rev-parse", "--show-toplevel"], runner); }
async function findWorktree(root: string, branch: string, issue: number, runner: CommandRunner): Promise<string | undefined> { const expected = resolve(root, ".worktrees", `issue-${issue}`); const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner)); const hit = entries.find((e) => e.branch === branch); if (hit && resolve(hit.path) !== expected) throw new BootstrapFinalizeError("AMBIGUOUS_CANDIDATE", `${branch} is checked out at non-canonical path ${hit.path}`); return hit ? expected : undefined; }

async function changedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const s = await gitRaw(worktree, [...CANONICAL_STATUS_ARGS], runner); return changedFilePathsFromStatus(s); }
async function committedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const base = await git(worktree, ["merge-base", "HEAD", "origin/main"], runner); const out = await git(worktree, ["diff", "--name-only", `${base}..HEAD`], runner); return out.split("\n").filter(Boolean).sort(); }

async function committedIdentityPaths(worktree: string, runner: CommandRunner): Promise<string[]> {
  // When origin/main advances after an issue branch was created, a committed
  // candidate that has already been merged is itself the ordinary merge-base
  // of HEAD and origin/main. Diffing from that raw merge-base would collapse a
  // real candidate C to zero delta, making it indistinguishable from an old
  // clean baseline branch A after main advanced A -> M. The canonical issue
  // branch reflog records the branch-creation commit during normal bootstrap
  // runs, so use it only to prove that HEAD is a real committed candidate;
  // verification deltas still use committedPaths() relative to current main.
  const head = await git(worktree, ["rev-parse", "HEAD"], runner);
  const branch = await tryGit(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], runner);
  const reflog = branch ? await tryGit(worktree, ["reflog", "show", "--format=%H", branch], runner) : undefined;
  const creationPoint = reflog?.split("\n").filter(Boolean).at(-1);
  const base = creationPoint && creationPoint !== head ? creationPoint : undefined;
  if (!base) return committedPaths(worktree, runner);
  const out = await git(worktree, ["diff", "--name-only", `${base}..HEAD`], runner);
  return out.split("\n").filter(Boolean).sort();
}

async function synchronizeLocalMain(input: { root: string; issueNumber: number; runner: CommandRunner; reporter?: (line: string) => void }): Promise<LocalMainSyncResult> {
  const report = (result: LocalMainSyncResult): LocalMainSyncResult => {
    if (result.status === "skipped") input.reporter?.(`bootstrap finalize #${input.issueNumber} · local-main sync skipped: ${result.reason ?? "not safely fast-forwardable"}`);
    else if (result.status === "already-current") input.reporter?.(`bootstrap finalize #${input.issueNumber} · local main already current`);
    else input.reporter?.(`bootstrap finalize #${input.issueNumber} · local main fast-forwarded`);
    return result;
  };

  const entries = parseWorktrees(await git(input.root, ["worktree", "list", "--porcelain"], input.runner));
  const canonicalRoot = entries[0]?.path ?? input.root;
  const rootStatus = await gitRaw(canonicalRoot, [...CANONICAL_STATUS_ARGS], input.runner);
  if (rootStatus.trimEnd().length > 0) return report({ status: "skipped", reason: "dirty root checkout" });

  const localMain = await tryGit(input.root, ["rev-parse", "--verify", "refs/heads/main"], input.runner);
  const originMain = await tryGit(input.root, ["rev-parse", "--verify", "refs/remotes/origin/main"], input.runner);
  if (!localMain) return report({ status: "skipped", reason: "local main is missing" });
  if (!originMain) return report({ status: "skipped", reason: "origin/main is missing" });
  if (localMain === originMain) return report({ status: "already-current", before: localMain, after: originMain });
  if ((await tryGit(input.root, ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"], input.runner)) === undefined) {
    return report({ status: "skipped", reason: "local main is ahead or diverged", before: localMain, after: originMain });
  }

  const mainWorktrees = entries.filter((entry) => entry.branch === "main");
  if (mainWorktrees.length > 1) return report({ status: "skipped", reason: "multiple main worktrees" });
  const mainWorktree = mainWorktrees[0];
  if (mainWorktree) {
    const mainStatus = await gitRaw(mainWorktree.path, [...CANONICAL_STATUS_ARGS], input.runner);
    if (mainStatus.trimEnd().length > 0) return report({ status: "skipped", reason: mainWorktree.path === canonicalRoot ? "dirty root checkout" : "dirty main checkout" });
    await git(mainWorktree.path, ["merge", "--ff-only", "origin/main"], input.runner);
  } else {
    await git(input.root, ["update-ref", "refs/heads/main", "refs/remotes/origin/main", "refs/heads/main"], input.runner);
  }
  const after = await git(input.root, ["rev-parse", "refs/heads/main"], input.runner);
  return report({ status: after === localMain ? "already-current" : "fast-forwarded", before: localMain, after });
}

async function cleanIntegratedWorkspace(input: { root: string; worktree?: string; branch: string; issueNumber: number; runner: CommandRunner; reporter?: (line: string) => void }): Promise<{ worktreeRemoved: boolean; localBranchRemoved: boolean }> {
  let worktreeRemoved = false;
  if (input.worktree) {
    if ((await git(input.worktree, ["status", "--porcelain"], input.runner)) !== "") throw new BootstrapFinalizeError("UNIQUE_WORK_PRESENT", "refusing cleanup with dirty worktree");
  }
  const branchExistsBeforeCleanup = await tryGit(input.root, ["rev-parse", "--verify", input.branch], input.runner);
  if (branchExistsBeforeCleanup && (await tryGit(input.root, ["merge-base", "--is-ancestor", input.branch, "origin/main"], input.runner)) === undefined) throw new BootstrapFinalizeError("UNINTEGRATED_BRANCH", "local branch contains work not reachable from origin/main");

  emitLifecycleCheckpoint("workspace_cleaned", "before");
  if (input.worktree) {
    await git(input.root, ["worktree", "remove", input.worktree], input.runner);
    try { if (existsSync(input.worktree)) await rm(input.worktree, { recursive: true, force: true }); } catch {}
    worktreeRemoved = true;
    input.reporter?.(`bootstrap finalize #${input.issueNumber} · worktree removed`);
  } else worktreeRemoved = true;

  const branchExists = await tryGit(input.root, ["rev-parse", "--verify", input.branch], input.runner);
  if (!branchExists) { emitLifecycleCheckpoint("workspace_cleaned", "after"); return { worktreeRemoved, localBranchRemoved: true }; }
  await git(input.root, ["branch", "-d", input.branch], input.runner);
  input.reporter?.(`bootstrap finalize #${input.issueNumber} · local branch removed`);
  emitLifecycleCheckpoint("workspace_cleaned", "after");
  return { worktreeRemoved, localBranchRemoved: true };
}

async function runBootstrapFinalizeUnlocked(options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeReport> {
  const runner = options.runCommand ?? runCommand;
  const root = await resolveRoot(options.cwd ?? process.cwd(), runner);
  const say = (msg: string) => options.reporter?.(msg);
  await git(root, ["fetch", "origin", "main", "--quiet"], runner);
  const issueNumber = await discoverIssue(root, options.issueNumber, runner);
  const branch = `agent/issue-${issueNumber}`;
  const workAuthority = options.authority ?? new GitHubWorkAuthority(root);
  const leaseAuthority = options.leaseAuthority ?? new SelfOwnedLeaseAuthority("bootstrap", `bootstrap-finalize-${issueNumber}`, "bootstrap-finalize");
  const issue = await workAuthority.get(String(issueNumber));
  const gitCommonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], runner);
  let worktree = await findWorktree(root, branch, issueNumber, runner);
  const branchExists = await tryGit(root, ["rev-parse", "--verify", branch], runner);

  let candidateSha: string;
  let needsCommitAndVerify: boolean;
  let alreadyIntegratedFastPathProven = false;

  // A durable local proof from a *previous* run's passing REQUIRED_CHECKS
  // that is now reachable from origin/main is the signal that this issue's
  // candidate was already verified and integrated - distinct from a brand
  // new branch, whose HEAD is trivially "reachable from origin/main" too
  // (it was just branched from there, nothing has diverged yet). Only the
  // proof, not a raw ancestry check on the worktree's current HEAD, can
  // tell those two states apart.
  const priorProof = await readVerifiedFinalizationCandidateProof(gitCommonDir, issueNumber);
  const priorProofIntegrated = priorProof && (await tryGit(root, ["merge-base", "--is-ancestor", priorProof.candidateSha, "origin/main"], runner)) !== undefined;

  if (!branchExists && !worktree) {
    // No live git evidence for this candidate - it may already have been
    // integrated and cleaned up by a prior successful run, with the
    // operator now reposting an external-verification result and rerunning
    // finalize to pick it up. Fall back to the durable proof rather than
    // requiring PR history that no longer exists in this design.
    if (!priorProof || !priorProofIntegrated) throw new BootstrapFinalizeError("MISSING_CANDIDATE", `no local ${branch} and no durable integrated-candidate proof found in ${root}`);
    // finalizeIssue() requires the local candidate branch to still exist
    // (it re-derives the tip from it as an anti-staleness check), which is
    // gone once a prior run's cleanup already ran. Nothing remains to
    // merge - the proof already proves reachability - so resolve the
    // remaining external-verification gate directly against the work
    // authority instead of routing a no-op merge through finalizeIssue().
    const gate = externalVerificationGate(issue);
    if (gate.status === "failed") throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_FAILED", "external verification failed; create a fresh implementation from current main");
    const issueClosed = gate.status === "clear";
    if (issueClosed && issue.state.toLowerCase() !== "closed") {
      await workAuthority.close(String(issueNumber), "Completed via pi-next automated workflow.");
    }
    const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
    return {
      ok: true,
      issueNumber,
      branch,
      candidateSha: priorProof.candidateSha,
      merged: true,
      reachable: true,
      issueClosed,
      worktreeRemoved: true,
      localBranchRemoved: true,
      localMainSync,
      outcome: issueClosed ? "finalized" : "integrated-pending-verification",
      ...(issueClosed ? {} : { pendingExternalVerification: true }),
    };
  } else {
    if (!worktree) throw new BootstrapFinalizeError("MISSING_WORKTREE", `canonical worktree for ${branch} is missing before integration`);
    await commitIncidentDiagnosticsBeforeFinalization({
      root,
      runCommand: runner,
      issueNumber,
      reporter: (line) => say(`bootstrap finalize #${issueNumber} · ${line}`),
    });
    await git(worktree, ["fetch", "origin", "main", "--quiet"], runner);
    await git(worktree, ["diff", "--check"], runner);
    const worktreeHead = await git(worktree, ["rev-parse", "HEAD"], runner);
    const originMainForHead = await tryGit(root, ["rev-parse", "origin/main"], runner);
    const dirty = await changedPaths(worktree, runner);
    const liveCommittedDelta = await committedPaths(worktree, runner);
    const liveCommittedIdentityDelta = await committedIdentityPaths(worktree, runner);
    const headReachableFromOriginMain = worktreeHead !== originMainForHead
      && (await tryGit(root, ["merge-base", "--is-ancestor", worktreeHead, "origin/main"], runner)) !== undefined;
    const staleProof = priorProof && priorProof.candidateSha !== worktreeHead ? priorProof : undefined;
    const exactProof = priorProof && priorProof.candidateSha === worktreeHead ? priorProof : undefined;
    // HEAD ancestry is candidate-integration evidence only for a clean
    // canonical worktree whose committed candidate identity is otherwise
    // mechanically visible.  A dirty/staged/untracked candidate is a newer
    // live candidate layered on top of HEAD, so raw reachability of HEAD (for
    // example an old baseline A after origin/main advanced A -> M) must never
    // bypass commit + verification of the dirty tree.
    const headAlreadyIntegrated = dirty.length === 0
      && headReachableFromOriginMain
      && (liveCommittedIdentityDelta.length > 0 || !!exactProof);
    const liveCandidateTakesPrecedence = !!staleProof && (headAlreadyIntegrated || liveCommittedIdentityDelta.length > 0);

    if (dirty.length) {
      const coordStatus = await git(root, ["status", "--porcelain"], runner);
      if (coordStatus) throw new BootstrapFinalizeError("ROOT_DIRTY", "coordination checkout is dirty");
      if (issue.state.trim().toLowerCase() === "closed") {
        throw new BootstrapFinalizeError("UNIQUE_WORK_PRESENT", "refusing to reinterpret dirty worktree as a new candidate after the issue is already closed");
      }
      if (liveCandidateTakesPrecedence) {
        throw new BootstrapFinalizeError(
          "STALE_PROOF_LIVE_CANDIDATE_DIRTY",
          `${branch}'s live candidate ${worktreeHead} supersedes stale proof ${staleProof!.candidateSha}, but the canonical worktree is dirty; preserving it for explicit reconciliation`,
        );
      }
      const intended = options.candidatePaths ? uniqueSortedGitPaths(options.candidatePaths) : dirty;
      if (dirty.some((p) => !intended.includes(p))) throw new BootstrapFinalizeError("UNKNOWN_CHANGES", "worktree contains changes outside intended candidate paths");
      await git(worktree, ["add", "--", ...intended], runner);
      const staged = await git(worktree, ["diff", "--cached", "--name-only"], runner);
      if (staged.split("\n").filter(Boolean).some((p) => !intended.includes(p))) throw new BootstrapFinalizeError("UNKNOWN_CHANGES", "staging would capture unintended paths");
      await git(worktree, ["commit", "-m", commitMessage(issue, issueNumber)], runner);
      say(`bootstrap finalize #${issueNumber} · committed ${await git(worktree, ["rev-parse", "--short", "HEAD"], runner)}`);
      candidateSha = await git(worktree, ["rev-parse", "HEAD"], runner);
      if ((await git(worktree, ["status", "--porcelain"], runner)) !== "") throw new BootstrapFinalizeError("DIRTY_AFTER_COMMIT", "candidate worktree remains dirty");
      needsCommitAndVerify = true;
      alreadyIntegratedFastPathProven = false;
    } else if (liveCandidateTakesPrecedence) {
      await invalidateVerifiedFinalizationCandidateProof({
        gitCommonDir,
        issueNumber,
        staleProof: staleProof!,
        reason: "live-candidate-advanced",
        liveCandidateSha: worktreeHead,
      });
      say(`bootstrap finalize #${issueNumber} · stale verified-candidate proof ${staleProof!.candidateSha.slice(0, 12)} invalidated; live candidate ${worktreeHead.slice(0, 12)} takes precedence`);
      candidateSha = worktreeHead;
      needsCommitAndVerify = !headAlreadyIntegrated;
      alreadyIntegratedFastPathProven = headAlreadyIntegrated;
    } else if (staleProof) {
      throw new BootstrapFinalizeError(
        "STALE_PROOF_AMBIGUOUS",
        `${branch}'s tip ${worktreeHead} does not match durable verified proof ${staleProof.candidateSha}, and no newer committed live candidate with a real delta was found`,
      );
    } else if (exactProof || headAlreadyIntegrated || priorProofIntegrated) {
      candidateSha = exactProof ? worktreeHead : headAlreadyIntegrated ? worktreeHead : priorProof!.candidateSha;
      needsCommitAndVerify = false;
      alreadyIntegratedFastPathProven = true;
    } else {
      candidateSha = worktreeHead;
      needsCommitAndVerify = true;
      alreadyIntegratedFastPathProven = false;
    }
  }

  // A candidate equal to origin/main's own current tip is not "already
  // integrated" - it is simply an unmodified/empty branch (git treats a
  // commit as trivially its own ancestor). Only a *distinct* commit that is
  // reachable from origin/main represents genuinely integrated content.
  const originMainTip = await git(root, ["rev-parse", "origin/main"], runner);
  const alreadyIntegrated = alreadyIntegratedFastPathProven
    && candidateSha !== originMainTip
    && (await tryGit(root, ["merge-base", "--is-ancestor", candidateSha, "origin/main"], runner)) !== undefined;

  if (!alreadyIntegrated) {
    const coordStatus = await git(root, ["status", "--porcelain"], runner);
    if (coordStatus) throw new BootstrapFinalizeError("ROOT_DIRTY", "coordination checkout is dirty");
  }

  if (alreadyIntegrated) {
    // Durably record this candidate as integrated even when it was verified
    // by another actor rather than this run's own REQUIRED_CHECKS, so a
    // later call (after this run's worktree/branch cleanup) can still
    // recover its identity - e.g. to pick up a pending-verification result
    // posted after cleanup - without needing PR history this design no
    // longer has.
    await writeVerifiedFinalizationCandidateProof({ gitCommonDir, issueNumber, candidateSha, candidatePaths: [], checks: needsCommitAndVerify ? [] : ["external-integration"] });
  }

  const verificationGate = externalVerificationGate(issue);
  if (verificationGate.status === "failed") {
    throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_FAILED", "external verification failed; create a fresh implementation from current main");
  }

  if (needsCommitAndVerify) {
    const delta = await committedPaths(worktree!, runner);
    if (delta.length === 0 && !alreadyIntegrated) {
      if (issue.state.toLowerCase() !== "closed") throw new BootstrapFinalizeError("NO_CHANGE_CANDIDATE", "candidate has no changes relative to origin/main and no authoritative already-satisfied proof");
      say(`bootstrap finalize #${issueNumber} · no candidate changes; issue already closed by authority`);
      const cleanup = await cleanIntegratedWorkspace({ root, worktree, branch, issueNumber, runner, reporter: say });
      const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
      return { ok: true, issueNumber, branch, candidateSha, merged: false, reachable: true, issueClosed: true, ...cleanup, localMainSync, outcome: "already-satisfied" };
    }
    // delta.length === 0 && alreadyIntegrated: HEAD is already fully
    // reachable from origin/main (e.g. merged by another actor without a
    // durable proof from this tool) - nothing of ours left to verify;
    // finalizeIssue()'s own already-on-main handling takes it from here.
    if (delta.length > 0) {
      for (const check of REQUIRED_CHECKS) await sh(worktree!, check, runner);
      await writeVerifiedFinalizationCandidateProof({ gitCommonDir, issueNumber, candidateSha, candidatePaths: delta, checks: REQUIRED_CHECKS });
      say(`bootstrap finalize #${issueNumber} · candidate verified`);
    }
  }
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "commit") process.exit(99);

  const pendingVerification: PendingVerificationRequest | undefined = verificationGate.status === "pending" ? { criteria: verificationGate.criteria } : undefined;
  const finalizeInput = {
    cwd: root,
    issueNumber,
    agent: "bootstrap",
    runId: `bootstrap-finalize-${issueNumber}`,
    sessionId: "bootstrap-finalize",
    candidateSha,
    issueUpdatedAt: issue.updatedAt ?? "",
    verifiedAuthorityFingerprint: authorityFingerprint(issue),
    ...(pendingVerification ? { pendingVerification } : {}),
  };
  let result;
  try {
    const recovery = await finalizeWithPostIntegrationReverification({
      leaseAuthority,
      workAuthority,
      finalizeInput,
      gitCommonDir,
      runCommand: runner,
      checks: REQUIRED_CHECKS,
      reporter: (line) => say(`bootstrap finalize #${issueNumber} · ${line}`),
    });
    if (recovery.status === "verification-failed") {
      const evidence = recovery.failedCheck.stderr || recovery.failedCheck.stdout || "no output";
      throw new BootstrapFinalizeError("VERIFY_FAILED", `${recovery.failedCheck.command} failed during post-integration reverification of ${recovery.mergeSha}: ${evidence}`);
    }
    if (recovery.status === "requires-reverification") {
      throw new BootstrapFinalizeError(
        "REQUIRES_REVERIFICATION",
        `origin/main advanced with unrelated commits during finalize; re-verify against current main (mergeSha=${recovery.mergeSha}) before retrying`,
      );
    }
    result = recovery.result;
  } catch (error) {
    if (error instanceof BootstrapFinalizeError) throw error;
    if (error instanceof FinalizeError) throw new BootstrapFinalizeError(error.code, error.message);
    throw error;
  }
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "merge") process.exit(99);

  say(`bootstrap finalize #${issueNumber} · reachable from origin/main`);
  const cleanup = await cleanIntegratedWorkspace({ root, worktree, branch, issueNumber, runner, reporter: say });
  const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
  const pendingExternalVerification = !result.closed && verificationGate.status === "pending";
  const outcome: BootstrapFinalizeReport["outcome"] = pendingExternalVerification
    ? "integrated-pending-verification"
    : result.closed
      ? "finalized"
      : "integrated-authority-changed";
  if (pendingExternalVerification) say(`bootstrap finalize #${issueNumber} · external verification pending · issue remains open`);
  say(`bootstrap finalize #${issueNumber} · ${pendingExternalVerification ? "INTEGRATED_PENDING_VERIFICATION" : localMainSync.status === "skipped" ? `PASS · local-main sync skipped: ${localMainSync.reason ?? "not safely fast-forwardable"}` : "PASS"}`);
  return {
    ok: true,
    issueNumber,
    branch,
    candidateSha,
    merged: true,
    reachable: true,
    issueClosed: result.closed,
    ...cleanup,
    localMainSync,
    outcome,
    ...(pendingExternalVerification ? { pendingExternalVerification: true } : {}),
  };
}

export async function runBootstrapFinalize(options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeReport> {
  const runner = options.runCommand ?? runCommand;
  const root = await resolveRoot(options.cwd ?? process.cwd(), runner);
  const commonDir = await git(options.cwd ?? process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"], runner);
  let lifecycleLock = options.lifecycleLock;
  let ownsLock = false;
  if (!lifecycleLock && options.issueNumber !== undefined) {
    lifecycleLock = await acquireBootstrapLifecycleLock({ root, gitCommonDir: commonDir, issueNumber: options.issueNumber, operation: "finalize", phase: "finalization" });
    ownsLock = true;
  }
  try {
    if (!lifecycleLock) {
      // Implicit candidate selection may inspect local Git first; acquire immediately after the issue is known.
      const issueNumber = await discoverIssue(root, options.issueNumber, runner);
      lifecycleLock = await acquireBootstrapLifecycleLock({ root, gitCommonDir: commonDir, issueNumber, operation: "finalize", phase: "finalization" });
      ownsLock = true;
      return await runBootstrapFinalizeUnlocked({ ...options, issueNumber, lifecycleLock });
    }
    await lifecycleLock.update("finalization");
    return await runBootstrapFinalizeUnlocked({ ...options, lifecycleLock });
  } finally {
    if (ownsLock) await lifecycleLock?.release();
  }
}

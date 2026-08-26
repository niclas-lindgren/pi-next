import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BootstrapError } from "./errors.js";
import { CommandRunner, RepositoryState, WorktreeEntry } from "./types.js";
import { assertCommand, git, gitOptional, isDirectory } from "./git-utils.js";
import { readCandidateState } from "./candidate.js";
import { candidateHasDelta } from "./zero-delta-retry-policy.js";
import { CANONICAL_STATUS_ARGS } from "./git-status.js";
import { commitIncidentDiagnostics } from "../coordination/incident-diagnostics-commit.ts";

function parseWorktrees(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function baselineForDirtyResumeInspection(root: string, runner: CommandRunner): Promise<string> {
  const originMain = await gitOptional(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], runner);
  if (originMain.exitCode === 0 && originMain.stdout.trim()) return originMain.stdout.trim();
  return git(root, ["rev-parse", "HEAD"], runner);
}

async function hasExistingCanonicalCandidate(
  root: string,
  issueNumber: number,
  baselineRevision: string,
  runner: CommandRunner,
): Promise<boolean> {
  const branch = `agent/issue-${issueNumber}`;
  const path = resolve(root, ".worktrees", `issue-${issueNumber}`);
  const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner));
  const registered = entries.find((entry) => resolve(entry.path) === path);
  if (!registered || registered.branch !== branch) return false;
  const state = await readCandidateState(path, baselineRevision, runner);
  return candidateHasDelta(state);
}

async function statusRaw(root: string, runner: CommandRunner): Promise<string> {
  const result = await runner("git", ["-C", root, ...CANONICAL_STATUS_ARGS], { cwd: root });
  assertCommand(result, "git status --porcelain=v1 --untracked-files=all");
  return result.stdout;
}

export async function prepareRepository(cwd: string, runner: CommandRunner, options: { issueNumber?: number } = {}): Promise<RepositoryState> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"], runner);
  const branch = await git(root, ["branch", "--show-current"], runner);
  if (branch !== "main") throw new BootstrapError(`coordination checkout must be on main, found ${branch || "detached HEAD"}`);
  if (resolve(cwd).includes(`${resolve(root)}/.worktrees/`)) {
    throw new BootstrapError("bootstrap must be started from the coordination checkout, not an issue worktree");
  }
  let rootStatus = await statusRaw(root, runner);
  if (rootStatus !== "") {
    const incidentCommit = await commitIncidentDiagnostics({ root, runCommand: runner });
    if (incidentCommit.status === "committed" || incidentCommit.status === "clean") {
      rootStatus = await statusRaw(root, runner);
    }
  }
  if (rootStatus !== "") {
    const mayResumeCanonicalCandidate = options.issueNumber !== undefined
      && await hasExistingCanonicalCandidate(root, options.issueNumber, await baselineForDirtyResumeInspection(root, runner), runner);
    if (!mayResumeCanonicalCandidate) {
      throw new BootstrapError("coordination checkout is dirty; preserving it and refusing to start");
    }
  }
  const fetched = await runner("git", ["-C", root, "fetch", "origin", "main", "--quiet"], { cwd: root });
  assertCommand(fetched, "fetch origin main");
  const baselineRevision = await git(root, ["rev-parse", "origin/main"], runner);
  const head = await git(root, ["rev-parse", "HEAD"], runner);
  const ancestry = await gitOptional(root, ["merge-base", "--is-ancestor", head, baselineRevision], runner);
  if (ancestry.exitCode !== 0) {
    throw new BootstrapError("local main is not an ancestor of origin/main; refusing to discard or rewrite local work");
  }
  return { root, baselineRevision };
}

export async function prepareWorktree(repository: RepositoryState, issueNumber: number, runner: CommandRunner): Promise<{ path: string; branch: string }> {
  const branch = `agent/issue-${issueNumber}`;
  const path = resolve(repository.root, ".worktrees", `issue-${issueNumber}`);
  await mkdir(dirname(path), { recursive: true });
  const entries = parseWorktrees(await git(repository.root, ["worktree", "list", "--porcelain"], runner));
  const registered = entries.find((entry) => resolve(entry.path) === path);
  const pathExists = await isDirectory(path);
  if (pathExists && !registered) throw new BootstrapError(`canonical worktree path exists but is not registered: ${path}`);
  if (registered && registered.branch !== branch) {
    throw new BootstrapError(`canonical worktree has ${registered.branch ?? "no branch"}, expected ${branch}`);
  }
  const branchEntry = entries.find((entry) => entry.branch === branch);
  if (branchEntry && resolve(branchEntry.path) !== path) {
    throw new BootstrapError(`canonical branch ${branch} is checked out at another path: ${branchEntry.path}`);
  }
  if (!registered) {
    const branchExists = (await gitOptional(repository.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], runner)).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", "--quiet", path, branch]
      : ["worktree", "add", "--quiet", "-b", branch, path, repository.baselineRevision];
    assertCommand(await runner("git", ["-C", repository.root, ...args], { cwd: repository.root }), "create canonical worktree");
  }
  const actualBranch = await git(path, ["branch", "--show-current"], runner);
  if (actualBranch !== branch) throw new BootstrapError(`canonical worktree branch mismatch: ${actualBranch}`);
  return { path, branch };
}

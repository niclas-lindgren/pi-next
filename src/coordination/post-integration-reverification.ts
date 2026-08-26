import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { prepareDependencies } from "../bootstrap/dependencies.ts";
import { parseGitStatus } from "../bootstrap/git-status.ts";
import { loadPiNextConfig } from "./config.ts";
import { finalizeIssue, type FinalizeInput, type FinalizeResult } from "./finalize.ts";
import { issueLeaseMatchesOwner, isIssueLeaseFresh } from "./issue-authority.ts";
import type { IssueLeaseAuthority } from "./issue-leases.ts";
import type { WorkAuthorityAdapter } from "./work-authority.ts";
import { REQUIRED_CHECKS } from "./required-checks.ts";
import { commitIncidentDiagnostics, type IncidentDiagnosticsCommitResult } from "./incident-diagnostics-commit.ts";

interface MinimalCommandResult { exitCode: number; stdout: string; stderr: string; signal?: string; durationMs?: number; }
export type ReverificationCommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<MinimalCommandResult>;
export type FinalizationResidueCommitResult = IncidentDiagnosticsCommitResult;

export interface IntegratedMainVerificationProof {
  version: 1;
  issueNumber: number;
  branch: string;
  candidateSha: string;
  mainSha: string;
  verifiedAt: string;
  checks: string[];
}

export interface ReverificationCheckRecord {
  command: string;
  exitCode: number;
  passed: boolean;
  stdout?: string;
  stderr?: string;
}

export type ExactMainReverificationResult =
  | { status: "verified"; mergeSha: string; source: "durable-proof" | "executed-checks"; checks: readonly ReverificationCheckRecord[] }
  | { status: "requires-reverification"; mergeSha: string; reason: "main-advanced" }
  | { status: "verification-failed"; mergeSha: string; failedCheck: ReverificationCheckRecord; checks: readonly ReverificationCheckRecord[] };

export type FinalizeRecoveryDisposition =
  | { status: "finalize-result"; result: FinalizeResult; reverifications: readonly ExactMainReverificationResult[] }
  | { status: "requires-reverification"; mergeSha: string; reverifications: readonly ExactMainReverificationResult[]; result?: FinalizeResult }
  | { status: "verification-failed"; mergeSha: string; failedCheck: ReverificationCheckRecord; reverifications: readonly ExactMainReverificationResult[]; result: FinalizeResult };

function proofDirectory(gitCommonDir: string): string {
  return join(resolve(gitCommonDir), "pi-next", "finalization");
}

export function verifiedIntegratedMainProofPath(gitCommonDir: string, issueNumber: number): string {
  return join(proofDirectory(gitCommonDir), `issue-${issueNumber}.verified-integrated-main.json`);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function parseProof(value: unknown, issueNumber: number): IntegratedMainVerificationProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.issueNumber !== issueNumber) return undefined;
  if (record.branch !== `agent/issue-${issueNumber}` || !isSha(record.candidateSha) || !isSha(record.mainSha)) return undefined;
  if (typeof record.verifiedAt !== "string" || !Array.isArray(record.checks) || !record.checks.every((item) => typeof item === "string")) return undefined;
  return record as unknown as IntegratedMainVerificationProof;
}

export async function readVerifiedIntegratedMainProof(gitCommonDir: string, issueNumber: number): Promise<IntegratedMainVerificationProof | undefined> {
  try {
    return parseProof(JSON.parse(await readFile(verifiedIntegratedMainProofPath(gitCommonDir, issueNumber), "utf8")), issueNumber);
  } catch {
    return undefined;
  }
}

export async function writeVerifiedIntegratedMainProof(input: {
  gitCommonDir: string;
  issueNumber: number;
  candidateSha: string;
  mainSha: string;
  checks: readonly string[];
  now?: Date;
}): Promise<void> {
  if (!isSha(input.candidateSha) || !isSha(input.mainSha)) return;
  const record: IntegratedMainVerificationProof = {
    version: 1,
    issueNumber: input.issueNumber,
    branch: `agent/issue-${input.issueNumber}`,
    candidateSha: input.candidateSha,
    mainSha: input.mainSha,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    checks: [...input.checks],
  };
  await mkdir(proofDirectory(input.gitCommonDir), { recursive: true });
  await writeFile(verifiedIntegratedMainProofPath(input.gitCommonDir, input.issueNumber), `${JSON.stringify(record, null, 2)}\n`);
}

async function git(root: string, args: string[], runner: ReverificationCommandRunner): Promise<string> {
  const result = await runner("git", ["-C", root, ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/**
 * Raw (untrimmed) stdout, for `git status --porcelain` output specifically.
 * git()'s blanket `.trim()` eats the leading space off a " M path"-style
 * first line (a 2-character status code that itself starts with a space),
 * corrupting exactly that one path. Pair with parseGitStatus's own
 * resilient two-pattern parse - not a second ad-hoc line parser here.
 */
async function gitRaw(root: string, args: string[], runner: ReverificationCommandRunner): Promise<string> {
  const result = await runner("git", ["-C", root, ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** Commit only sanitized incident diagnostics left by prior failed finalizers; all other dirty paths still fail closed. */
export async function commitIncidentDiagnosticsBeforeFinalization(input: {
  root: string;
  runCommand: ReverificationCommandRunner;
  reporter?: (line: string) => void;
}): Promise<FinalizationResidueCommitResult> {
  return commitIncidentDiagnostics({ ...input, reporter: input.reporter ? (line) => input.reporter?.(line.replace(/^incident diagnostics · committed /, "finalization · committed incident diagnostics ")) : undefined });
}

function verificationWorkspacePath(root: string, issueNumber: number, mergeSha: string): string {
  return join(resolve(root), ".worktrees", `.pi-next-reverify-${issueNumber}-${mergeSha}`);
}

async function prepareExactMainVerificationWorkspace(input: {
  root: string;
  issueNumber: number;
  mergeSha: string;
  runner: ReverificationCommandRunner;
}): Promise<string> {
  const workspace = verificationWorkspacePath(input.root, input.issueNumber, input.mergeSha);
  await mkdir(join(resolve(input.root), ".worktrees"), { recursive: true });
  const existingHead = await git(workspace, ["rev-parse", "--verify", "HEAD"], input.runner).catch(() => undefined);
  if (existingHead !== undefined) {
    if (existingHead !== input.mergeSha) {
      throw new Error(`post-integration reverification workspace ${workspace} is at ${existingHead}, expected ${input.mergeSha}`);
    }
    return workspace;
  }

  await git(input.root, ["rev-parse", "--verify", `${input.mergeSha}^{commit}`], input.runner);
  await git(input.root, ["worktree", "add", "--detach", workspace, input.mergeSha], input.runner);
  const head = await git(workspace, ["rev-parse", "HEAD"], input.runner);
  if (head !== input.mergeSha) throw new Error(`verification workspace is at ${head}, expected ${input.mergeSha}`);
  return workspace;
}

async function ensureVerificationWorkspaceDependencies(
  workspace: string,
  runner: ReverificationCommandRunner,
  reporter?: (line: string) => void,
): Promise<void> {
  const report = await prepareDependencies(workspace, async (command, args, options) => {
    const started = Date.now();
    const result = await runner(command, args, { cwd: options.cwd });
    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs ?? Date.now() - started,
    };
  }, 10 * 60_000);
  if (report.action !== "not-required") reporter?.(`post-integration reverification · dependencies ${report.action}`);
}

async function cleanupExactMainVerificationWorkspace(input: {
  root: string;
  workspace: string;
  runner: ReverificationCommandRunner;
  reporter?: (line: string) => void;
}): Promise<void> {
  const gitDir = await git(input.workspace, ["rev-parse", "--git-dir"], input.runner).catch(() => undefined);
  if (!gitDir) return;
  const status = await gitRaw(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], input.runner).catch(() => "");
  const unsafeResidue = parseGitStatus(status).filter((entry) => {
    const ignored = entry.index === "!" && entry.worktree === "!";
    return !(ignored && (entry.path === "node_modules" || entry.path.startsWith("node_modules/")));
  });
  if (unsafeResidue.length > 0) {
    input.reporter?.(`post-integration reverification · preserved dirty verification workspace ${input.workspace}`);
    return;
  }
  const result = await input.runner("git", ["-C", input.root, "worktree", "remove", input.workspace], { cwd: input.root });
  if (result.exitCode !== 0) {
    input.reporter?.(`post-integration reverification · workspace cleanup skipped: ${(result.stderr || result.stdout).trim()}`);
  }
}

function checksMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function bounded(value: string): string | undefined {
  const trimmed = value.slice(-4000);
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function reverifyExactIntegratedMain(input: {
  root: string;
  gitCommonDir: string;
  issueNumber: number;
  candidateSha: string;
  mergeSha: string;
  runCommand: ReverificationCommandRunner;
  checks?: readonly string[];
  reporter?: (line: string) => void;
}): Promise<ExactMainReverificationResult> {
  const checks = input.checks ?? REQUIRED_CHECKS;
  await git(input.root, ["fetch", "origin", "main", "--quiet"], input.runCommand);
  let currentMain = await git(input.root, ["rev-parse", "refs/remotes/origin/main"], input.runCommand);
  if (currentMain !== input.mergeSha) return { status: "requires-reverification", mergeSha: currentMain, reason: "main-advanced" };

  const proof = await readVerifiedIntegratedMainProof(input.gitCommonDir, input.issueNumber);
  if (
    proof?.candidateSha === input.candidateSha &&
    proof.mainSha === input.mergeSha &&
    checksMatch(proof.checks, checks)
  ) {
    await git(input.root, ["fetch", "origin", "main", "--quiet"], input.runCommand);
    const stillCurrent = await git(input.root, ["rev-parse", "refs/remotes/origin/main"], input.runCommand);
    if (stillCurrent === input.mergeSha) return { status: "verified", mergeSha: input.mergeSha, source: "durable-proof", checks: [] };
    return { status: "requires-reverification", mergeSha: stillCurrent, reason: "main-advanced" };
  }

  const workspace = await prepareExactMainVerificationWorkspace({
    root: input.root,
    issueNumber: input.issueNumber,
    mergeSha: input.mergeSha,
    runner: input.runCommand,
  });

  const records: ReverificationCheckRecord[] = [];
  try {
    try {
      await ensureVerificationWorkspaceDependencies(workspace, input.runCommand, input.reporter);
    } catch (error) {
      const record: ReverificationCheckRecord = {
        command: "prepare verification workspace dependencies",
        exitCode: 1,
        passed: false,
        stderr: bounded(error instanceof Error ? error.message : String(error)),
      };
      records.push(record);
      return { status: "verification-failed", mergeSha: input.mergeSha, failedCheck: record, checks: records };
    }

    for (const command of checks) {
      input.reporter?.(`post-integration reverification · ${command}`);
      const result = await input.runCommand("sh", ["-c", command], { cwd: workspace });
      const record: ReverificationCheckRecord = {
        command,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        ...(result.exitCode === 0 ? {} : { stdout: bounded(result.stdout), stderr: bounded(result.stderr) }),
      };
      records.push(record);
      if (result.exitCode !== 0) return { status: "verification-failed", mergeSha: input.mergeSha, failedCheck: record, checks: records };
    }

    const headAfter = await git(workspace, ["rev-parse", "HEAD"], input.runCommand);
    await git(input.root, ["fetch", "origin", "main", "--quiet"], input.runCommand);
    const currentAfter = await git(input.root, ["rev-parse", "refs/remotes/origin/main"], input.runCommand);
    if (headAfter !== input.mergeSha || currentAfter !== input.mergeSha) {
      return { status: "requires-reverification", mergeSha: currentAfter, reason: "main-advanced" };
    }

    await writeVerifiedIntegratedMainProof({
      gitCommonDir: input.gitCommonDir,
      issueNumber: input.issueNumber,
      candidateSha: input.candidateSha,
      mainSha: input.mergeSha,
      checks,
    });
    return { status: "verified", mergeSha: input.mergeSha, source: "executed-checks", checks: records };
  } finally {
    await cleanupExactMainVerificationWorkspace({ root: input.root, workspace, runner: input.runCommand, reporter: input.reporter });
  }
}

export async function finalizeWithPostIntegrationReverification(input: {
  leaseAuthority: IssueLeaseAuthority;
  workAuthority: WorkAuthorityAdapter;
  finalizeInput: FinalizeInput;
  gitCommonDir: string;
  runCommand: ReverificationCommandRunner;
  checks?: readonly string[];
  maxReverificationAttempts?: number;
  reporter?: (line: string) => void;
}): Promise<FinalizeRecoveryDisposition> {
  const maxAttempts = input.maxReverificationAttempts ?? 3;
  const reverifications: ExactMainReverificationResult[] = [];
  const lease = await input.leaseAuthority.read(input.finalizeInput.issueNumber);
  if (lease && issueLeaseMatchesOwner(lease, input.finalizeInput) && isIssueLeaseFresh(lease, new Date())) {
    await commitIncidentDiagnosticsBeforeFinalization({
      root: input.finalizeInput.cwd,
      runCommand: input.runCommand,
      reporter: input.reporter,
    });
  }
  let result = await finalizeIssue(input.leaseAuthority, input.workAuthority, input.finalizeInput);

  while (result.requiresReverification && reverifications.length < maxAttempts) {
    const reverified = await reverifyExactIntegratedMain({
      root: input.finalizeInput.cwd,
      gitCommonDir: input.gitCommonDir,
      issueNumber: input.finalizeInput.issueNumber,
      candidateSha: input.finalizeInput.candidateSha,
      mergeSha: result.mergeSha,
      runCommand: input.runCommand,
      checks: input.checks,
      reporter: input.reporter,
    });
    reverifications.push(reverified);
    if (reverified.status === "verification-failed") {
      return { status: "verification-failed", mergeSha: reverified.mergeSha, failedCheck: reverified.failedCheck, reverifications, result };
    }
    if (reverified.status === "requires-reverification") {
      result = { ...result, mergeSha: reverified.mergeSha, requiresReverification: true, closed: false };
      continue;
    }
    result = await finalizeIssue(input.leaseAuthority, input.workAuthority, { ...input.finalizeInput, verifiedIntegratedMain: reverified.mergeSha });
  }

  if (result.requiresReverification) return { status: "requires-reverification", mergeSha: result.mergeSha, reverifications, result };
  return { status: "finalize-result", result, reverifications };
}

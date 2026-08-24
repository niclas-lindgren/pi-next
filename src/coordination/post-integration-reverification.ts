import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { finalizeIssue, type FinalizeInput, type FinalizeResult } from "./finalize.ts";
import type { IssueLeaseAuthority } from "./issue-leases.ts";
import type { WorkAuthorityAdapter } from "./work-authority.ts";
import { REQUIRED_CHECKS } from "./required-checks.ts";

interface MinimalCommandResult { exitCode: number; stdout: string; stderr: string; signal?: string; durationMs?: number; }
export type ReverificationCommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<MinimalCommandResult>;

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

async function cleanMainCheckoutAt(root: string, target: string, runner: ReverificationCommandRunner): Promise<void> {
  const branch = await git(root, ["branch", "--show-current"], runner);
  if (branch !== "main") throw new Error(`post-integration reverification requires the coordination root on main; found ${branch || "detached HEAD"}`);
  const dirty = await git(root, ["status", "--porcelain"], runner);
  if (dirty.trim()) throw new Error("post-integration reverification requires a clean coordination root");
  const localMain = await git(root, ["rev-parse", "HEAD"], runner);
  if (localMain === target) return;
  const counts = await git(root, ["rev-list", "--left-right", "--count", `${localMain}...${target}`], runner);
  const [aheadRaw = "0"] = counts.split(/\s+/);
  if (Number.parseInt(aheadRaw, 10) > 0) throw new Error("local main has unpublished commits ahead of the integrated main revision; reconcile explicitly before reverification");
  await git(root, ["merge", "--ff-only", target], runner);
  const head = await git(root, ["rev-parse", "HEAD"], runner);
  if (head !== target) throw new Error(`failed to place main at exact integrated revision ${target}`);
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
  const currentMain = await git(input.root, ["rev-parse", "refs/remotes/origin/main"], input.runCommand);
  if (currentMain !== input.mergeSha) return { status: "requires-reverification", mergeSha: currentMain, reason: "main-advanced" };

  await cleanMainCheckoutAt(input.root, input.mergeSha, input.runCommand);

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

  const records: ReverificationCheckRecord[] = [];
  for (const command of checks) {
    input.reporter?.(`post-integration reverification · ${command}`);
    const result = await input.runCommand("sh", ["-c", command], { cwd: input.root });
    const record: ReverificationCheckRecord = {
      command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      ...(result.exitCode === 0 ? {} : { stdout: bounded(result.stdout), stderr: bounded(result.stderr) }),
    };
    records.push(record);
    if (result.exitCode !== 0) return { status: "verification-failed", mergeSha: input.mergeSha, failedCheck: record, checks: records };
  }

  const headAfter = await git(input.root, ["rev-parse", "HEAD"], input.runCommand);
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

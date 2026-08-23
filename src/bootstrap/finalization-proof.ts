import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface MinimalCommandResult { exitCode: number; stdout: string; stderr: string; }
type MinimalRunner = (command: string, args: string[], options: { cwd: string }) => Promise<MinimalCommandResult>;

export interface VerifiedFinalizationCandidateProof {
  version: 1;
  issueNumber: number;
  branch: string;
  candidateSha: string;
  candidatePaths: string[];
  verifiedAt: string;
  checks: string[];
}

function proofDirectory(gitCommonDir: string): string {
  return join(resolve(gitCommonDir), "pi-next", "bootstrap-lifecycle");
}

function proofPath(gitCommonDir: string, issueNumber: number): string {
  return join(proofDirectory(gitCommonDir), `issue-${issueNumber}.verified-candidate.json`);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function parseProof(value: unknown, issueNumber: number): VerifiedFinalizationCandidateProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.issueNumber !== issueNumber) return undefined;
  if (record.branch !== `agent/issue-${issueNumber}` || !isSha(record.candidateSha)) return undefined;
  if (typeof record.verifiedAt !== "string" || !Array.isArray(record.checks) || !record.checks.every((item) => typeof item === "string")) return undefined;
  if (!Array.isArray(record.candidatePaths) || !record.candidatePaths.every((item) => typeof item === "string" && item.length > 0 && !item.startsWith("/") && !item.includes("\0"))) return undefined;
  return record as unknown as VerifiedFinalizationCandidateProof;
}

export async function writeVerifiedFinalizationCandidateProof(input: {
  gitCommonDir: string;
  issueNumber: number;
  candidateSha: string;
  candidatePaths: string[];
  checks: readonly string[];
  now?: Date;
}): Promise<void> {
  if (!isSha(input.candidateSha)) return;
  const record: VerifiedFinalizationCandidateProof = {
    version: 1,
    issueNumber: input.issueNumber,
    branch: `agent/issue-${input.issueNumber}`,
    candidateSha: input.candidateSha,
    candidatePaths: [...new Set(input.candidatePaths)].sort(),
    verifiedAt: (input.now ?? new Date()).toISOString(),
    checks: [...input.checks],
  };
  await mkdir(proofDirectory(input.gitCommonDir), { recursive: true });
  await writeFile(proofPath(input.gitCommonDir, input.issueNumber), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readVerifiedFinalizationCandidateProof(gitCommonDir: string, issueNumber: number): Promise<VerifiedFinalizationCandidateProof | undefined> {
  try {
    return parseProof(JSON.parse(await readFile(proofPath(gitCommonDir, issueNumber), "utf8")), issueNumber);
  } catch {
    return undefined;
  }
}

export async function hasExactVerifiedFinalizationCandidate(input: {
  root: string;
  gitCommonDir: string;
  issueNumber: number;
  runCommand: MinimalRunner;
}): Promise<boolean> {
  const proof = await readVerifiedFinalizationCandidateProof(input.gitCommonDir, input.issueNumber);
  if (!proof) return false;
  const ref = await input.runCommand("git", ["-C", input.root, "rev-parse", "--verify", proof.branch], { cwd: input.root });
  return ref.exitCode === 0 && ref.stdout.trim() === proof.candidateSha;
}

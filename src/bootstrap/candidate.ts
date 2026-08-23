import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { BootstrapError } from "./errors.js";
import { CandidateState, CommandRunner, MAX_CHANGED_FILES, MAX_PACKET_BYTES } from "./types.js";
import { git } from "./git-utils.js";
import { CANONICAL_STATUS_ARGS, parseGitStatus, uniqueSortedGitPaths } from "./git-status.js";
import { redactSecrets } from "./utils.js";

function splitLines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}

async function revCount(cwd: string, range: string, runner: CommandRunner): Promise<number> {
  return Number(await git(cwd, ["rev-list", "--count", range], runner));
}

export async function readCandidateState(cwd: string, baselineRevision: string, runner: CommandRunner): Promise<CandidateState> {
  const headRevision = await git(cwd, ["rev-parse", "HEAD"], runner);
  const mergeBaseRevision = await git(cwd, ["merge-base", baselineRevision, headRevision], runner);
  const [status, committedFilesText, stagedFilesText, unstagedFilesText, aheadMerge, aheadMain, behindMain] = await Promise.all([
    git(cwd, [...CANONICAL_STATUS_ARGS], runner),
    git(cwd, ["diff", "--name-only", `${mergeBaseRevision}..${headRevision}`], runner),
    git(cwd, ["diff", "--cached", "--name-only"], runner),
    git(cwd, ["diff", "--name-only"], runner),
    revCount(cwd, `${mergeBaseRevision}..${headRevision}`, runner),
    revCount(cwd, `${baselineRevision}..${headRevision}`, runner),
    revCount(cwd, `${headRevision}..${baselineRevision}`, runner),
  ]);
  const entries = parseGitStatus(status);
  const committedFiles = uniqueSortedGitPaths(splitLines(committedFilesText));
  const stagedFiles = uniqueSortedGitPaths([...splitLines(stagedFilesText), ...entries.filter((entry) => entry.index !== " " && !entry.untracked).map((entry) => entry.path)]);
  const unstagedFiles = uniqueSortedGitPaths([...splitLines(unstagedFilesText), ...entries.filter((entry) => entry.worktree !== " " && !entry.untracked).map((entry) => entry.path)]);
  const untrackedFiles = uniqueSortedGitPaths(entries.filter((entry) => entry.untracked).map((entry) => entry.path));
  const changedFiles = uniqueSortedGitPaths([...committedFiles, ...stagedFiles, ...unstagedFiles, ...untrackedFiles]).slice(0, MAX_CHANGED_FILES);
  return {
    headRevision,
    baselineRevision,
    originMainRevision: baselineRevision,
    mergeBaseRevision,
    dirty: status.length > 0,
    changedFiles,
    committedChanges: aheadMerge > 0,
    uncommittedChanges: status.length > 0,
    committedFiles,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    commitsAheadOfMergeBase: aheadMerge,
    commitsAheadOfOriginMain: aheadMain,
    commitsBehindOriginMain: behindMain,
    behindOriginMain: behindMain > 0,
    divergedFromOriginMain: aheadMain > 0 && behindMain > 0,
  };
}

function assertRelativeGitPath(path: string): void {
  if (path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new BootstrapError(`unsafe candidate path in git status: ${path}`);
}

async function untrackedEvidence(cwd: string, files: string[]): Promise<string> {
  if (files.length === 0) return "(none)";
  const sections: string[] = [];
  let total = 0;
  for (const file of files) {
    assertRelativeGitPath(file);
    const absolute = resolve(cwd, file);
    if (!absolute.startsWith(`${resolve(cwd)}/`)) throw new BootstrapError(`unsafe candidate path in git status: ${file}`);
    const entry = await stat(absolute).catch(() => undefined);
    if (!entry?.isFile()) throw new BootstrapError(`untracked candidate path is not a regular text file: ${file}`);
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) throw new BootstrapError(`untracked candidate file cannot be represented as bounded text evidence: ${file}`);
    const content = redactSecrets(bytes.toString("utf8"));
    const section = `--- BEGIN UNTRACKED FILE ${file} ---\n${content}\n--- END UNTRACKED FILE ${file} ---`;
    total += section.length;
    if (total > MAX_PACKET_BYTES) throw new BootstrapError("exact candidate evidence is too large for the bounded reviewer packet");
    sections.push(section);
  }
  return sections.join("\n\n");
}

export async function candidateEvidence(cwd: string, baselineRevision: string, revision: string, runner: CommandRunner): Promise<string> {
  const mergeBaseRevision = await git(cwd, ["merge-base", baselineRevision, revision], runner);
  const status = await git(cwd, [...CANONICAL_STATUS_ARGS], runner);
  const untrackedFiles = uniqueSortedGitPaths(parseGitStatus(status).filter((entry) => entry.untracked).map((entry) => entry.path));
  const [committed, staged, unstaged, untracked] = await Promise.all([
    git(cwd, ["diff", "--no-ext-diff", `${mergeBaseRevision}..${revision}`], runner),
    git(cwd, ["diff", "--cached", "--no-ext-diff"], runner),
    git(cwd, ["diff", "--no-ext-diff"], runner),
    untrackedEvidence(cwd, untrackedFiles),
  ]);
  const evidence = [
    `ORIGIN_MAIN: ${baselineRevision}`,
    `REVISION: ${revision}`,
    `MERGE_BASE: ${mergeBaseRevision}`,
    `STATUS:\n${status || "(clean)"}`,
    `COMMITTED DIFF (MERGE_BASE..HEAD):\n${committed || "(none)"}`,
    `STAGED DIFF:\n${staged || "(none)"}`,
    `UNSTAGED DIFF:\n${unstaged || "(none)"}`,
    `UNTRACKED FILE CONTENTS:\n${untracked}`,
  ].join("\n\n");
  if (evidence.length > MAX_PACKET_BYTES) throw new BootstrapError("exact candidate evidence is too large for the bounded reviewer packet");
  return evidence;
}

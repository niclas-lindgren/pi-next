import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Durable handoff between a worker's "I believe I'm ready to promote" tool
 * call (extensions/pi-next/checkpoint.ts's `requestPromotion`, invoked mid-
 * session) and the controller-side step that actually performs the merge
 * (#146: the worker no longer merges/pushes to main directly). Stored under
 * the shared git-common-dir so it survives being read from a different
 * worktree than the one that wrote it (the worker's issue worktree vs. the
 * controller's coordination-root checkout).
 */
export interface PromotionRequest {
  version: 1;
  issueNumber: number;
  runId: string;
  branch: string;
  checkpointSha: string;
  mainSha: string;
  fingerprint: string;
  requestedAt: string;
}

function requestDirectory(gitCommonDir: string): string {
  return join(resolve(gitCommonDir), "pi-next", "promotion-requests");
}

function requestPath(gitCommonDir: string, issueNumber: number): string {
  return join(requestDirectory(gitCommonDir), `issue-${issueNumber}.promotion-request.json`);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function parseRequest(value: unknown, issueNumber: number): PromotionRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.issueNumber !== issueNumber) return undefined;
  if (typeof record.branch !== "string" || !record.branch) return undefined;
  if (!isSha(record.checkpointSha) || !isSha(record.mainSha)) return undefined;
  if (typeof record.fingerprint !== "string" || !record.fingerprint) return undefined;
  if (typeof record.runId !== "string" || !record.runId) return undefined;
  if (typeof record.requestedAt !== "string" || !record.requestedAt) return undefined;
  return record as unknown as PromotionRequest;
}

export async function writePromotionRequest(input: {
  gitCommonDir: string;
  issueNumber: number;
  runId: string;
  branch: string;
  checkpointSha: string;
  mainSha: string;
  fingerprint: string;
  now?: Date;
}): Promise<void> {
  const record: PromotionRequest = {
    version: 1,
    issueNumber: input.issueNumber,
    runId: input.runId,
    branch: input.branch,
    checkpointSha: input.checkpointSha,
    mainSha: input.mainSha,
    fingerprint: input.fingerprint,
    requestedAt: (input.now ?? new Date()).toISOString(),
  };
  await mkdir(requestDirectory(input.gitCommonDir), { recursive: true });
  await writeFile(requestPath(input.gitCommonDir, input.issueNumber), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readPromotionRequest(gitCommonDir: string, issueNumber: number): Promise<PromotionRequest | undefined> {
  try {
    return parseRequest(JSON.parse(await readFile(requestPath(gitCommonDir, issueNumber), "utf8")), issueNumber);
  } catch {
    return undefined;
  }
}

export async function clearPromotionRequest(gitCommonDir: string, issueNumber: number): Promise<void> {
  await rm(requestPath(gitCommonDir, issueNumber), { force: true });
}

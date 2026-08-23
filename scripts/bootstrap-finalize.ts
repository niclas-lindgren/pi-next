import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireBootstrapLifecycleLock, type BootstrapLifecycleLock } from "../src/bootstrap/lifecycle-lock.js";
import { writeVerifiedFinalizationCandidateProof } from "../src/bootstrap/finalization-proof.js";

const execFileAsync = promisify(execFile);
const REQUIRED_CHECKS = ["npm run typecheck", "npm test"] as const;

export interface CommandResult { command: string; args: string[]; cwd: string; exitCode: number; stdout: string; stderr: string; }
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export interface BootstrapFinalizeIssue { number: number; title: string; body?: string; state: "OPEN" | "CLOSED"; updatedAt?: string; comments?: unknown[]; labels?: string[]; }
export interface BootstrapFinalizePr { number: number; headRefName: string; headSha: string; baseRefName: string; state: "OPEN" | "MERGED" | "CLOSED"; mergeCommitSha?: string; }
export type CiState = "PASS" | "FAIL" | "PENDING" | "TIMEOUT" | "NONE" | "UNKNOWN";
export type CheckConclusion = CiState | "MISSING";
export interface CiEvaluation { state: CheckConclusion; reason?: string; }

export interface BootstrapFinalizeAuthority {
  fetchIssue(issueNumber: number, cwd: string): Promise<BootstrapFinalizeIssue>;
  listPullRequests(branch: string, cwd: string): Promise<BootstrapFinalizePr[]>;
  createPullRequest(input: { issue: BootstrapFinalizeIssue; branch: string; headSha: string; cwd: string }): Promise<BootstrapFinalizePr>;
  waitForChecks(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string; issueNumber?: number; reporter?: (line: string) => void }): Promise<CheckConclusion | CiEvaluation>;
  mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }): Promise<BootstrapFinalizePr>;
  closeIssue(issueNumber: number, cwd: string): Promise<void>;
}

export interface BootstrapFinalizeOptions { cwd?: string; issueNumber?: number; authority?: BootstrapFinalizeAuthority; runCommand?: CommandRunner; candidatePaths?: string[]; reporter?: (line: string) => void; lifecycleLock?: BootstrapLifecycleLock; }
export type LocalMainSyncStatus = "fast-forwarded" | "already-current" | "skipped";
export interface LocalMainSyncResult { status: LocalMainSyncStatus; reason?: string; before?: string; after?: string; }
export interface BootstrapFinalizeReport { ok: boolean; issueNumber: number; branch: string; candidateSha: string; pr?: number; merged: boolean; reachable: boolean; issueClosed: boolean; worktreeRemoved: boolean; localBranchRemoved: boolean; localMainSync?: LocalMainSyncResult; outcome: "finalized" | "already-satisfied" | "integrated-pending-verification"; pendingExternalVerification?: boolean; }

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
const PENDING_VERIFICATION_MARKER = "<!-- pi-next-pending-verification -->";
const PENDING_VERIFICATION_RESULT_MARKER = "<!-- pi-next-pending-verification-result -->";
interface PendingVerificationRecord { version: 1; status: "awaiting_external_verification"; criteria: Array<{ id: string; description: string; environment: string }>; integratedMainSha: string; }
interface PendingVerificationResult { version: 1; integratedMainSha: string; status: "passed" | "failed"; evidence: string; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validatePendingMarker(value: unknown): PendingVerificationRecord { if (!record(value) || value.version !== 1 || value.status !== "awaiting_external_verification" || typeof value.integratedMainSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.integratedMainSha) || !Array.isArray(value.criteria) || value.criteria.length === 0) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "malformed pending external verification authority marker"); for (const c of value.criteria) if (!record(c) || typeof c.id !== "string" || !c.id.trim() || typeof c.description !== "string" || !c.description.trim() || typeof c.environment !== "string" || !c.environment.trim()) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "malformed pending external verification authority marker"); return value as unknown as PendingVerificationRecord; }
function validateResultMarker(value: unknown): PendingVerificationResult { if (!record(value) || value.version !== 1 || (value.status !== "passed" && value.status !== "failed") || typeof value.integratedMainSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.integratedMainSha) || typeof value.evidence !== "string" || !value.evidence.trim()) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "malformed pending external verification result marker"); return value as unknown as PendingVerificationResult; }
function structuredMarkers<T>(issue: BootstrapFinalizeIssue, marker: string, validate: (value: unknown) => T): T[] { const out: T[] = []; for (const c of issue.comments ?? []) { const body = typeof c === "object" && c && "body" in c ? String((c as { body?: unknown }).body ?? "").trim() : ""; if (!body.startsWith(`${marker}\n`)) continue; try { out.push(validate(JSON.parse(body.slice(marker.length).trim()))); } catch (error) { if (error instanceof BootstrapFinalizeError) throw error; throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "malformed pending external verification authority marker"); } } return out; }
function externalVerificationDisposition(issue: BootstrapFinalizeIssue): "pending" | "failed" | "clear" { const pending = structuredMarkers(issue, PENDING_VERIFICATION_MARKER, validatePendingMarker); const results = structuredMarkers(issue, PENDING_VERIFICATION_RESULT_MARKER, validateResultMarker); if (pending.length === 0) return "clear"; const current = pending[pending.length - 1]!; if (pending.some((entry) => JSON.stringify(entry) !== JSON.stringify(current))) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "conflicting pending external verification authority markers"); if (results.length > 0) { const result = results[results.length - 1]!; if (results.some((entry) => JSON.stringify(entry) !== JSON.stringify(result))) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_AUTHORITY_INVALID", "conflicting pending external verification result markers"); if (result.integratedMainSha === current.integratedMainSha && result.status === "passed") return "clear"; if (result.integratedMainSha === current.integratedMainSha && result.status === "failed") return "failed"; } return "pending"; }
export function classifyExternalVerificationAuthority(issue: BootstrapFinalizeIssue): "pending" | "clear" { return externalVerificationDisposition(issue) === "pending" ? "pending" : "clear"; }
function authorityFingerprint(issue: BootstrapFinalizeIssue): string { return JSON.stringify({ title: issue.title, body: issue.body ?? "", updatedAt: issue.updatedAt ?? "", labels: [...(issue.labels ?? [])].sort(), comments: issue.comments ?? [] }); }
function commitMessage(issue: BootstrapFinalizeIssue): string { const title = issue.title.trim().replace(/\s+/g, " ").slice(0, 72); return `${title || "bootstrap candidate"} (#${issue.number})`; }

async function discoverIssue(root: string, explicit: number | undefined, runner: CommandRunner): Promise<number> {
  if (explicit !== undefined) return explicit;
  const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner));
  const plausible = new Set<number>();
  const addIfLiveCandidate = async (issue: number, branch: string, worktreePath?: string) => {
    const dirty = worktreePath ? (await gitRaw(worktreePath, ["status", "--porcelain=v1"], runner)).trimEnd().length > 0 : false;
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

async function changedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const s = await gitRaw(worktree, ["status", "--porcelain=v1"], runner); return [...new Set(s.split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop()!))].sort(); }
async function committedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const base = await git(worktree, ["merge-base", "HEAD", "origin/main"], runner); const out = await git(worktree, ["diff", "--name-only", `${base}..HEAD`], runner); return out.split("\n").filter(Boolean).sort(); }
function exactMergedPr(prs: BootstrapFinalizePr[], candidateSha: string | undefined): BootstrapFinalizePr | undefined {
  const merged = prs.filter((p) => p.state === "MERGED" && p.mergeCommitSha);
  if (candidateSha) {
    const exact = merged.filter((p) => p.headSha === candidateSha);
    if (exact.length > 1) throw new BootstrapFinalizeError("AMBIGUOUS_PR", "multiple merged PRs match the exact candidate SHA");
    return exact[0];
  }
  if (merged.length > 1) throw new BootstrapFinalizeError("AMBIGUOUS_PR", "multiple merged PRs exist for the reusable issue branch without exact candidate identity");
  return merged[0];
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
  const rootStatus = await gitRaw(canonicalRoot, ["status", "--porcelain=v1"], input.runner);
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
    const mainStatus = await gitRaw(mainWorktree.path, ["status", "--porcelain=v1"], input.runner);
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
    await git(input.root, ["worktree", "remove", input.worktree], input.runner);
    try { if (existsSync(input.worktree)) await rm(input.worktree, { recursive: true, force: true }); } catch {}
    worktreeRemoved = true;
    input.reporter?.(`bootstrap finalize #${input.issueNumber} · worktree removed`);
  } else worktreeRemoved = true;

  const branchExists = await tryGit(input.root, ["rev-parse", "--verify", input.branch], input.runner);
  if (!branchExists) return { worktreeRemoved, localBranchRemoved: true };
  if ((await tryGit(input.root, ["merge-base", "--is-ancestor", input.branch, "origin/main"], input.runner)) === undefined) throw new BootstrapFinalizeError("UNINTEGRATED_BRANCH", "local branch contains work not reachable from origin/main");
  await git(input.root, ["branch", "-d", input.branch], input.runner);
  input.reporter?.(`bootstrap finalize #${input.issueNumber} · local branch removed`);
  return { worktreeRemoved, localBranchRemoved: true };
}

function normalizeCiEvaluation(value: CheckConclusion | CiEvaluation): CiEvaluation { return typeof value === "string" ? { state: value } : value; }
function isNoChecksCliResult(result: CommandResult): boolean { return result.exitCode !== 0 && /no checks|no check runs|no status checks|no checks reported|not found/i.test(`${result.stdout}\n${result.stderr}`); }
function classifyCheckRows(rows: Array<{ state?: string | null; conclusion?: string | null; bucket?: string | null }>): CiState {
  if (rows.length === 0) return "NONE";
  const values = rows.map((row) => `${row.state ?? ""} ${row.conclusion ?? ""} ${row.bucket ?? ""}`.trim());
  if (values.some((value) => /fail|failure|error|cancel|timed[_ -]?out|action_required/i.test(value))) return "FAIL";
  if (values.some((value) => /queued|pending|progress|running|waiting|requested|expected/i.test(value))) return "PENDING";
  // Generic lifecycle states such as "completed" are not sufficient PASS evidence.
  if (values.every((value) => /pass|success|skip|neutral/i.test(value))) return "PASS";
  return "UNKNOWN";
}
function parseRequiredStatusContexts(text: string): string[] { const raw = JSON.parse(text) as { contexts?: unknown; checks?: Array<{ context?: unknown }> }; return [...(Array.isArray(raw.contexts) ? raw.contexts : []), ...(Array.isArray(raw.checks) ? raw.checks.map((c) => c.context) : [])].filter((v): v is string => typeof v === "string" && v.length > 0); }

export function classifyCiEvidence(input: { checkRows: Array<{ name?: string | null; state?: string | null; conclusion?: string | null; bucket?: string | null }>; requiredContexts?: string[]; checksUnavailable?: boolean; noChecksCliExit?: boolean }): CiEvaluation {
  if (input.checksUnavailable) return { state: "UNKNOWN", reason: "CI provider unavailable" };
  const requiredContexts = input.requiredContexts ?? [];
  const state = classifyCheckRows(input.checkRows);
  if (state === "NONE") return requiredContexts.length > 0 ? { state: "MISSING", reason: `required checks missing: ${requiredContexts.join(", ")}` } : { state: "NONE", reason: input.noChecksCliExit ? "no checks reported by GitHub CLI" : "no checks reported" };
  if (requiredContexts.length === 0) return { state };
  const rowsByName = new Map(input.checkRows.map((row) => [String((row as { name?: unknown }).name ?? row.state ?? ""), row]));
  const missing = requiredContexts.filter((context) => !rowsByName.has(context));
  if (missing.length > 0) return { state: "MISSING", reason: `required checks missing: ${missing.join(", ")}` };
  return { state };
}

export async function evaluateGhPrChecks(input: { cwd: string; prNumber: number; requiredContexts: string[]; runCommand?: CommandRunner }): Promise<CiEvaluation> {
  const runner = input.runCommand ?? runCommand;
  const r = await runner("gh", ["pr", "checks", String(input.prNumber), "--json", "name,state,bucket"], { cwd: input.cwd });
  if (r.exitCode !== 0 && !isNoChecksCliResult(r)) return { state: "UNKNOWN", reason: (r.stderr || r.stdout).trim() || "gh pr checks unavailable" };
  try {
    const rows = r.exitCode === 0 ? JSON.parse(r.stdout) as Array<{ name?: string; state?: string; bucket?: string }> : [];
    return classifyCiEvidence({ checkRows: rows, requiredContexts: input.requiredContexts, noChecksCliExit: r.exitCode !== 0 });
  } catch (error) {
    return { state: "UNKNOWN", reason: `could not parse gh pr checks output: ${error instanceof Error ? error.message : String(error)}` };
  }
}

class GhAuthority implements BootstrapFinalizeAuthority {
  async fetchIssue(issueNumber: number, cwd: string): Promise<BootstrapFinalizeIssue> { const r = await runCommand("gh", ["issue", "view", String(issueNumber), "--json", "number,title,body,state,updatedAt,comments,labels"], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("AUTHORITY_FAILED", r.stderr || r.stdout); const raw = JSON.parse(r.stdout) as { number: number; title: string; body?: string; state?: string; updatedAt?: string; comments?: unknown[]; labels?: Array<{ name?: string } | string> }; const state: "OPEN" | "CLOSED" = raw.state === "CLOSED" ? "CLOSED" : "OPEN"; return { number: raw.number, title: raw.title, body: raw.body ?? "", state, updatedAt: raw.updatedAt, comments: raw.comments ?? [], labels: (raw.labels ?? []).map((l: { name?: string } | string) => typeof l === "string" ? l : l.name).filter((label): label is string => Boolean(label)) }; }
  async listPullRequests(branch: string, cwd: string): Promise<BootstrapFinalizePr[]> { const r = await runCommand("gh", ["pr", "list", "--head", branch, "--base", "main", "--state", "all", "--json", "number,headRefName,headRefOid,baseRefName,state,mergeCommit"], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("AUTHORITY_FAILED", r.stderr || r.stdout); return (JSON.parse(r.stdout) as Array<{ number: number; headRefName: string; headRefOid: string; baseRefName: string; state: string; mergeCommit?: { oid?: string } }>).map((p): BootstrapFinalizePr => ({ number: p.number, headRefName: p.headRefName, headSha: p.headRefOid, baseRefName: p.baseRefName, state: p.state === "MERGED" ? "MERGED" : p.state === "CLOSED" ? "CLOSED" : "OPEN", mergeCommitSha: p.mergeCommit?.oid })); }
  async createPullRequest(input: { issue: BootstrapFinalizeIssue; branch: string; headSha: string; cwd: string }): Promise<BootstrapFinalizePr> { const r = await runCommand("gh", ["pr", "create", "--base", "main", "--head", input.branch, "--title", commitMessage(input.issue), "--body", `Finalizes #${input.issue.number}.`], { cwd: input.cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("PR_FAILED", r.stderr || r.stdout); const prs = await this.listPullRequests(input.branch, input.cwd); return prs.find((p: BootstrapFinalizePr) => p.headSha === input.headSha && p.state === "OPEN") ?? prs[0]!; }
  async waitForChecks(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string; issueNumber?: number; reporter?: (line: string) => void }): Promise<CiEvaluation> {
    const required = await this.requiredStatusContexts(input.cwd);
    if (required === undefined) return { state: "UNKNOWN", reason: "required-check policy unavailable" };
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      const evaluation = await evaluateGhPrChecks({ cwd: input.cwd, prNumber: input.pr.number, requiredContexts: required });
      if (evaluation.state === "PENDING") {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        input.reporter?.(`bootstrap finalize #${input.issueNumber ?? input.pr.number} · CI · waiting · elapsed=${elapsed}s`);
        await new Promise((res) => setTimeout(res, 5_000));
        continue;
      }
      return evaluation;
    }
    return { state: "TIMEOUT", reason: "required checks still pending after bounded polling" };
  }
  private async requiredStatusContexts(cwd: string): Promise<string[] | undefined> {
    const repo = await runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd });
    if (repo.exitCode !== 0) return undefined;
    let nameWithOwner = "";
    try { nameWithOwner = (JSON.parse(repo.stdout) as { nameWithOwner?: string }).nameWithOwner ?? ""; } catch { return undefined; }
    if (!nameWithOwner) return undefined;
    const protection = await runCommand("gh", ["api", `repos/${nameWithOwner}/branches/main/protection/required_status_checks`], { cwd });
    if (protection.exitCode !== 0) {
      const text = `${protection.stdout}\n${protection.stderr}`;
      if (/404|not found|branch not protected/i.test(text)) return [];
      return undefined;
    }
    try { return parseRequiredStatusContexts(protection.stdout); } catch { return undefined; }
  }
  async mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }) { const r = await runCommand("gh", ["pr", "merge", String(input.pr.number), "--merge", "--delete-branch=false"], { cwd: input.cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("MERGE_FAILED", r.stderr || r.stdout); return { ...input.pr, state: "MERGED" as const }; }
  async closeIssue(issueNumber: number, cwd: string) { const r = await runCommand("gh", ["issue", "close", String(issueNumber), "--comment", "Finalized by bootstrap finalizer after merge reachability proof."], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("CLOSE_FAILED", r.stderr || r.stdout); }
}

async function runBootstrapFinalizeUnlocked(options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeReport> {
  const runner = options.runCommand ?? runCommand;
  const root = await resolveRoot(options.cwd ?? process.cwd(), runner);
  const say = (msg: string) => options.reporter?.(msg);
  await git(root, ["fetch", "origin", "main", "--quiet"], runner);
  const issueNumber = await discoverIssue(root, options.issueNumber, runner);
  const branch = `agent/issue-${issueNumber}`;
  const authority = options.authority ?? new GhAuthority();
  const issue = await authority.fetchIssue(issueNumber, root);
  const initialAuthorityFingerprint = authorityFingerprint(issue);
  const worktree = await findWorktree(root, branch, issueNumber, runner);
  const branchExists = await tryGit(root, ["rev-parse", "--verify", branch], runner);
  const localCandidateSha = worktree ? await git(worktree, ["rev-parse", "HEAD"], runner) : branchExists ? await git(root, ["rev-parse", branch], runner) : undefined;
  const prsBeforeClassification = await authority.listPullRequests(branch, root);
  const alreadyMerged = exactMergedPr(prsBeforeClassification, localCandidateSha);
  if (alreadyMerged) {
    const candidateSha = alreadyMerged.headSha;
    await git(root, ["fetch", "origin", "main", "--quiet"], runner);
    const candidateReachable = (await tryGit(root, ["merge-base", "--is-ancestor", candidateSha, "origin/main"], runner)) !== undefined;
    const mergeReachable = (await tryGit(root, ["merge-base", "--is-ancestor", alreadyMerged.mergeCommitSha!, "origin/main"], runner)) !== undefined;
    if (!candidateReachable || !mergeReachable) throw new BootstrapFinalizeError("REACHABILITY_FAILED", "exact merged candidate is not durably reachable from origin/main");
    say(`bootstrap finalize #${issueNumber} · exact merged PR #${alreadyMerged.number} already reachable from origin/main`);
    const latest = await authority.fetchIssue(issueNumber, root);
    let issueClosed = latest.state === "CLOSED";
    const externalDisposition = externalVerificationDisposition(latest);
    if (!issueClosed && authorityFingerprint(latest) !== initialAuthorityFingerprint) throw new BootstrapFinalizeError("STALE_AUTHORITY", "issue authority changed before closure");
    if (!issueClosed && externalDisposition === "failed") throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_FAILED", "external verification failed; create a fresh implementation from current main");
    if (!issueClosed && externalDisposition === "clear") { await authority.closeIssue(issueNumber, root); issueClosed = true; say(`bootstrap finalize #${issueNumber} · issue closed`); }
    if (!issueClosed && externalDisposition === "pending") say(`bootstrap finalize #${issueNumber} · external verification pending · issue remains open`);
    const cleanup = await cleanIntegratedWorkspace({ root, worktree, branch, issueNumber, runner, reporter: say });
    const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
    const pendingExternalVerification = !issueClosed && externalDisposition === "pending";
    say(`bootstrap finalize #${issueNumber} · ${pendingExternalVerification ? "INTEGRATED_PENDING_VERIFICATION" : localMainSync.status === "skipped" ? `PASS · local-main sync skipped: ${localMainSync.reason ?? "not safely fast-forwardable"}` : "PASS"}`);
    return { ok: true, issueNumber, branch, candidateSha, pr: alreadyMerged.number, merged: true, reachable: true, issueClosed, ...cleanup, localMainSync, outcome: pendingExternalVerification ? "integrated-pending-verification" : "finalized", ...(pendingExternalVerification ? { pendingExternalVerification: true } : {}) };
  }
  if (!branchExists && !worktree) throw new BootstrapFinalizeError("MISSING_CANDIDATE", `no local ${branch} and no exact merged PR evidence`);
  if (!worktree) throw new BootstrapFinalizeError("MISSING_WORKTREE", `canonical worktree for ${branch} is missing before integration`);
  const coordStatus = await git(root, ["status", "--porcelain"], runner);
  if (coordStatus) throw new BootstrapFinalizeError("ROOT_DIRTY", "coordination checkout is dirty");
  await git(worktree, ["fetch", "origin", "main", "--quiet"], runner);
  await git(worktree, ["diff", "--check"], runner);
  const dirty = await changedPaths(worktree, runner);
  const intended = options.candidatePaths ? [...options.candidatePaths].sort() : dirty;
  if (dirty.some((p) => !intended.includes(p))) throw new BootstrapFinalizeError("UNKNOWN_CHANGES", "worktree contains changes outside intended candidate paths");
  if (dirty.length) { await git(worktree, ["add", "--", ...intended], runner); const staged = await git(worktree, ["diff", "--cached", "--name-only"], runner); if (staged.split("\n").filter(Boolean).some((p) => !intended.includes(p))) throw new BootstrapFinalizeError("UNKNOWN_CHANGES", "staging would capture unintended paths"); await git(worktree, ["commit", "-m", commitMessage(issue)], runner); say(`bootstrap finalize #${issueNumber} · committed ${await git(worktree, ["rev-parse", "--short", "HEAD"], runner)}`); }
  const candidateSha = await git(worktree, ["rev-parse", "HEAD"], runner);
  if ((await git(worktree, ["status", "--porcelain"], runner)) !== "") throw new BootstrapFinalizeError("DIRTY_AFTER_COMMIT", "candidate worktree remains dirty");
  if ((await committedPaths(worktree, runner)).length === 0) {
    if (issue.state !== "CLOSED") throw new BootstrapFinalizeError("NO_CHANGE_CANDIDATE", "candidate has no changes relative to origin/main and no authoritative already-satisfied proof");
    const candidateSha = await git(worktree, ["rev-parse", "HEAD"], runner);
    say(`bootstrap finalize #${issueNumber} · no candidate changes; issue already closed by authority`);
    await git(root, ["worktree", "remove", worktree], runner);
    let branchRemoved = false;
    if ((await tryGit(root, ["merge-base", "--is-ancestor", branch, "origin/main"], runner)) !== undefined) { await git(root, ["branch", "-d", branch], runner); branchRemoved = true; }
    else throw new BootstrapFinalizeError("UNINTEGRATED_BRANCH", "local branch contains work not reachable from origin/main");
    try { if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true }); } catch {}
    const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
    return { ok: true, issueNumber, branch, candidateSha, merged: false, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: branchRemoved, localMainSync, outcome: "already-satisfied" };
  }
  for (const check of REQUIRED_CHECKS) await sh(worktree, check, runner);
  await writeVerifiedFinalizationCandidateProof({
    gitCommonDir: await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], runner),
    issueNumber,
    candidateSha,
    candidatePaths: await committedPaths(worktree, runner),
    checks: REQUIRED_CHECKS,
  });
  say(`bootstrap finalize #${issueNumber} · candidate verified`);
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "commit") process.exit(99);
  await git(worktree, ["push", "-u", "origin", branch], runner);
  say(`bootstrap finalize #${issueNumber} · pushed ${branch}`);
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "push") process.exit(99);
  let prs = await authority.listPullRequests(branch, root);
  const relevantPrs = prs.filter((p) => p.headSha === candidateSha || p.state !== "MERGED");
  if (relevantPrs.length > 1) throw new BootstrapFinalizeError("AMBIGUOUS_PR", `multiple PRs for ${branch}`);
  let pr = relevantPrs[0];
  if (pr && pr.headSha !== candidateSha && pr.state !== "MERGED") throw new BootstrapFinalizeError("PR_SHA_MISMATCH", "existing PR points to a different candidate SHA");
  if (!pr) pr = await authority.createPullRequest({ issue, branch, headSha: candidateSha, cwd: root });
  say(`bootstrap finalize #${issueNumber} · PR #${pr.number} ready`);
  if (pr.state !== "MERGED") {
    const checks = normalizeCiEvaluation(await authority.waitForChecks({ pr, headSha: candidateSha, cwd: root, issueNumber, reporter: say }));
    if (checks.state === "NONE") say(`bootstrap finalize #${issueNumber} · CI · no required checks`);
    else if (checks.state === "PASS") say(`bootstrap finalize #${issueNumber} · CI · PASS`);
    else if (checks.state === "MISSING") throw new BootstrapFinalizeError("CI_MISSING", checks.reason ?? "required CI checks are missing");
    else if (checks.state === "UNKNOWN") throw new BootstrapFinalizeError("CI_UNKNOWN", checks.reason ?? "required CI could not be evaluated");
    else throw new BootstrapFinalizeError("CI_NOT_PASSING", `required CI ${checks.state}${checks.reason ? `: ${checks.reason}` : ""}`);
    const remoteHead = await git(root, ["ls-remote", "origin", `refs/heads/${branch}`], runner);
    if (!remoteHead.startsWith(candidateSha)) throw new BootstrapFinalizeError("CANDIDATE_CHANGED", "branch changed while waiting for CI");
    pr = await authority.mergePullRequest({ pr, headSha: candidateSha, cwd: root });
    say(`bootstrap finalize #${issueNumber} · merged ${pr.mergeCommitSha ?? ""}`.trim());
  }
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "merge") process.exit(99);
  await git(root, ["fetch", "origin", "main", "--quiet"], runner);
  const reachable = (await tryGit(root, ["merge-base", "--is-ancestor", candidateSha, "origin/main"], runner)) !== undefined;
  if (!reachable) throw new BootstrapFinalizeError("REACHABILITY_FAILED", "candidate is not reachable from origin/main");
  say(`bootstrap finalize #${issueNumber} · reachable from origin/main`);
  const latest = await authority.fetchIssue(issueNumber, root);
  let issueClosed = latest.state === "CLOSED";
  const externalDisposition = externalVerificationDisposition(latest);
  if (!issueClosed && authorityFingerprint(latest) !== initialAuthorityFingerprint) throw new BootstrapFinalizeError("STALE_AUTHORITY", "issue authority changed before closure");
  if (!issueClosed && externalDisposition === "failed") throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_FAILED", "external verification failed; create a fresh implementation from current main");
  if (!issueClosed && externalDisposition === "clear") { await authority.closeIssue(issueNumber, root); issueClosed = true; say(`bootstrap finalize #${issueNumber} · issue closed`); }
  if (!issueClosed && externalDisposition === "pending") say(`bootstrap finalize #${issueNumber} · external verification pending · issue remains open`);
  const cleanup = await cleanIntegratedWorkspace({ root, worktree, branch, issueNumber, runner, reporter: say });
  const localMainSync = await synchronizeLocalMain({ root, issueNumber, runner, reporter: say });
  const pendingExternalVerification = !issueClosed && externalDisposition === "pending";
  say(`bootstrap finalize #${issueNumber} · ${pendingExternalVerification ? "INTEGRATED_PENDING_VERIFICATION" : localMainSync.status === "skipped" ? `PASS · local-main sync skipped: ${localMainSync.reason ?? "not safely fast-forwardable"}` : "PASS"}`);
  return { ok: true, issueNumber, branch, candidateSha, pr: pr.number, merged: true, reachable, issueClosed, ...cleanup, localMainSync, outcome: pendingExternalVerification ? "integrated-pending-verification" : "finalized", ...(pendingExternalVerification ? { pendingExternalVerification: true } : {}) };
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

function usage(): string { return `Usage: npm run bootstrap:finalize -- [--issue N]\n\nFinalize one mechanically-passing bootstrap candidate.\n\nOptions:\n  --issue N   finalize the explicit canonical agent/issue-N candidate\n  -h, --help  show this help\n`; }
function parseArgs(argv: string[]): { issueNumber?: number; help?: boolean } { const out: { issueNumber?: number; help?: boolean } = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === "--issue") { const value = argv[++i]; if (!value || !/^\d+$/.test(value)) throw new BootstrapFinalizeError("USAGE", "--issue requires a numeric issue number"); out.issueNumber = Number(value); } else if (arg === "--help" || arg === "-h") out.help = true; else throw new BootstrapFinalizeError("USAGE", `unknown argument: ${arg}`); } return out; }
export async function main(argv = process.argv.slice(2)): Promise<void> { const args = parseArgs(argv); if (args.help) { console.log(usage()); return; } const report = await runBootstrapFinalize({ issueNumber: args.issueNumber, reporter: (l) => console.log(l) }); console.log(JSON.stringify({ bootstrapFinalize: report })); }

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

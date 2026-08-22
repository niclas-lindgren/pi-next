import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_CHECKS = ["npm run typecheck", "npm test"] as const;

export interface CommandResult { command: string; args: string[]; cwd: string; exitCode: number; stdout: string; stderr: string; }
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export interface BootstrapFinalizeIssue { number: number; title: string; body?: string; state: "OPEN" | "CLOSED"; updatedAt?: string; comments?: unknown[]; labels?: string[]; }
export interface BootstrapFinalizePr { number: number; headRefName: string; headSha: string; baseRefName: string; state: "OPEN" | "MERGED" | "CLOSED"; mergeCommitSha?: string; }
export type CheckConclusion = "PASS" | "FAIL" | "TIMEOUT" | "PENDING";

export interface BootstrapFinalizeAuthority {
  fetchIssue(issueNumber: number, cwd: string): Promise<BootstrapFinalizeIssue>;
  listPullRequests(branch: string, cwd: string): Promise<BootstrapFinalizePr[]>;
  createPullRequest(input: { issue: BootstrapFinalizeIssue; branch: string; headSha: string; cwd: string }): Promise<BootstrapFinalizePr>;
  waitForChecks(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }): Promise<CheckConclusion>;
  mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }): Promise<BootstrapFinalizePr>;
  closeIssue(issueNumber: number, cwd: string): Promise<void>;
}

export interface BootstrapFinalizeOptions { cwd?: string; issueNumber?: number; authority?: BootstrapFinalizeAuthority; runCommand?: CommandRunner; candidatePaths?: string[]; reporter?: (line: string) => void; }
export interface BootstrapFinalizeReport { ok: boolean; issueNumber: number; branch: string; candidateSha: string; pr?: number; merged: boolean; reachable: boolean; issueClosed: boolean; worktreeRemoved: boolean; localBranchRemoved: boolean; }

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

async function git(cwd: string, args: string[], runner: CommandRunner): Promise<string> {
  const r = await runner("git", ["-C", cwd, ...args], { cwd });
  if (r.exitCode !== 0) throw new BootstrapFinalizeError("GIT_FAILED", `git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
async function tryGit(cwd: string, args: string[], runner: CommandRunner): Promise<string | undefined> { try { return await git(cwd, args, runner); } catch { return undefined; } }
async function sh(cwd: string, command: string, runner: CommandRunner): Promise<void> { const r = await runner("sh", ["-c", command], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("VERIFY_FAILED", `${command} failed: ${(r.stderr || r.stdout).slice(0, 4000)}`); }

interface WorktreeEntry { path: string; branch?: string; }
function parseWorktrees(text: string): WorktreeEntry[] { const out: WorktreeEntry[] = []; let cur: WorktreeEntry | undefined; for (const line of text.split("\n")) { if (line.startsWith("worktree ")) { if (cur) out.push(cur); cur = { path: line.slice(9) }; } else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, ""); } if (cur) out.push(cur); return out; }
function issueFromBranch(branch?: string): number | undefined { const m = branch?.match(/^agent\/issue-(\d+)$/); return m ? Number(m[1]) : undefined; }
function isExternalPending(issue: BootstrapFinalizeIssue): boolean { const text = `${issue.body ?? ""}\n${(issue.comments ?? []).map((c) => typeof c === "object" && c && "body" in c ? String((c as { body?: unknown }).body ?? "") : "").join("\n")}`; return /pending external verification|awaiting external verification|post[- ]deploy verification/i.test(text); }
function authorityFingerprint(issue: BootstrapFinalizeIssue): string { return JSON.stringify({ title: issue.title, body: issue.body ?? "", updatedAt: issue.updatedAt ?? "", labels: [...(issue.labels ?? [])].sort(), comments: issue.comments ?? [] }); }
function commitMessage(issue: BootstrapFinalizeIssue): string { const title = issue.title.trim().replace(/\s+/g, " ").slice(0, 72); return `${title || "bootstrap candidate"} (#${issue.number})`; }

async function discoverIssue(root: string, explicit: number | undefined, runner: CommandRunner): Promise<number> {
  if (explicit !== undefined) return explicit;
  const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner));
  const plausible = new Set<number>();
  for (const e of entries) { const n = issueFromBranch(e.branch); if (n && basename(e.path) === `issue-${n}` && basename(dirname(e.path)) === ".worktrees") plausible.add(n); }
  const branches = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agent/issue-*"], runner).catch(() => "");
  for (const b of branches.split("\n").filter(Boolean)) { const n = issueFromBranch(b); if (n) plausible.add(n); }
  if (plausible.size !== 1) throw new BootstrapFinalizeError("AMBIGUOUS_CANDIDATE", `expected one bootstrap candidate, found ${plausible.size}`);
  return [...plausible][0]!;
}

async function resolveRoot(cwd: string, runner: CommandRunner): Promise<string> { return git(cwd, ["rev-parse", "--show-toplevel"], runner); }
async function findWorktree(root: string, branch: string, issue: number, runner: CommandRunner): Promise<string | undefined> { const expected = resolve(root, ".worktrees", `issue-${issue}`); const entries = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"], runner)); const hit = entries.find((e) => e.branch === branch); if (hit && resolve(hit.path) !== expected) throw new BootstrapFinalizeError("AMBIGUOUS_CANDIDATE", `${branch} is checked out at non-canonical path ${hit.path}`); return hit ? expected : undefined; }

async function changedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const s = await git(worktree, ["status", "--porcelain=v1"], runner); return [...new Set(s.split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop()!))].sort(); }
async function committedPaths(worktree: string, runner: CommandRunner): Promise<string[]> { const base = await git(worktree, ["merge-base", "HEAD", "origin/main"], runner); const out = await git(worktree, ["diff", "--name-only", `${base}..HEAD`], runner); return out.split("\n").filter(Boolean).sort(); }

class GhAuthority implements BootstrapFinalizeAuthority {
  async fetchIssue(issueNumber: number, cwd: string): Promise<BootstrapFinalizeIssue> { const r = await runCommand("gh", ["issue", "view", String(issueNumber), "--json", "number,title,body,state,updatedAt,comments,labels"], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("AUTHORITY_FAILED", r.stderr || r.stdout); const raw = JSON.parse(r.stdout) as { number: number; title: string; body?: string; state?: string; updatedAt?: string; comments?: unknown[]; labels?: Array<{ name?: string } | string> }; const state: "OPEN" | "CLOSED" = raw.state === "CLOSED" ? "CLOSED" : "OPEN"; return { number: raw.number, title: raw.title, body: raw.body ?? "", state, updatedAt: raw.updatedAt, comments: raw.comments ?? [], labels: (raw.labels ?? []).map((l: { name?: string } | string) => typeof l === "string" ? l : l.name).filter((label): label is string => Boolean(label)) }; }
  async listPullRequests(branch: string, cwd: string): Promise<BootstrapFinalizePr[]> { const r = await runCommand("gh", ["pr", "list", "--head", branch, "--base", "main", "--state", "all", "--json", "number,headRefName,headRefOid,baseRefName,state,mergeCommit"], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("AUTHORITY_FAILED", r.stderr || r.stdout); return (JSON.parse(r.stdout) as Array<{ number: number; headRefName: string; headRefOid: string; baseRefName: string; state: string; mergeCommit?: { oid?: string } }>).map((p): BootstrapFinalizePr => ({ number: p.number, headRefName: p.headRefName, headSha: p.headRefOid, baseRefName: p.baseRefName, state: p.state === "MERGED" ? "MERGED" : p.state === "CLOSED" ? "CLOSED" : "OPEN", mergeCommitSha: p.mergeCommit?.oid })); }
  async createPullRequest(input: { issue: BootstrapFinalizeIssue; branch: string; headSha: string; cwd: string }): Promise<BootstrapFinalizePr> { const r = await runCommand("gh", ["pr", "create", "--base", "main", "--head", input.branch, "--title", commitMessage(input.issue), "--body", `Finalizes #${input.issue.number}.`], { cwd: input.cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("PR_FAILED", r.stderr || r.stdout); const prs = await this.listPullRequests(input.branch, input.cwd); return prs.find((p: BootstrapFinalizePr) => p.headSha === input.headSha && p.state === "OPEN") ?? prs[0]!; }
  async waitForChecks(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }) { for (let i = 0; i < 20; i++) { const r = await runCommand("gh", ["pr", "checks", String(input.pr.number), "--json", "state"], { cwd: input.cwd }); if (r.exitCode !== 0) return "FAIL"; const states = JSON.parse(r.stdout) as Array<{ state: string }>; if (states.length === 0 || states.every((s) => /PASS|SUCCESS|SKIP/i.test(s.state))) return "PASS"; if (states.some((s) => /FAIL|ERROR|CANCEL/i.test(s.state))) return "FAIL"; await new Promise((res) => setTimeout(res, 5_000)); } return "TIMEOUT"; }
  async mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string; cwd: string }) { const r = await runCommand("gh", ["pr", "merge", String(input.pr.number), "--merge", "--delete-branch=false"], { cwd: input.cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("MERGE_FAILED", r.stderr || r.stdout); return { ...input.pr, state: "MERGED" as const }; }
  async closeIssue(issueNumber: number, cwd: string) { const r = await runCommand("gh", ["issue", "close", String(issueNumber), "--comment", "Finalized by bootstrap finalizer after merge reachability proof."], { cwd }); if (r.exitCode !== 0) throw new BootstrapFinalizeError("CLOSE_FAILED", r.stderr || r.stdout); }
}

export async function runBootstrapFinalize(options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeReport> {
  const runner = options.runCommand ?? runCommand;
  const root = await resolveRoot(options.cwd ?? process.cwd(), runner);
  const say = (msg: string) => options.reporter?.(msg);
  const issueNumber = await discoverIssue(root, options.issueNumber, runner);
  const branch = `agent/issue-${issueNumber}`;
  const authority = options.authority ?? new GhAuthority();
  const issue = await authority.fetchIssue(issueNumber, root);
  const initialAuthorityFingerprint = authorityFingerprint(issue);
  await git(root, ["fetch", "origin", "main", "--quiet"], runner);
  const worktree = await findWorktree(root, branch, issueNumber, runner);
  const branchExists = await tryGit(root, ["rev-parse", "--verify", branch], runner);
  if (!branchExists && !worktree) {
    const prs = await authority.listPullRequests(branch, root);
    const merged = prs.find((p) => p.state === "MERGED" && p.mergeCommitSha);
    if (!merged) throw new BootstrapFinalizeError("MISSING_CANDIDATE", `no local ${branch} and no merged PR evidence`);
    await git(root, ["fetch", "origin", "main", "--quiet"], runner);
    const reachable = (await tryGit(root, ["merge-base", "--is-ancestor", merged.mergeCommitSha!, "origin/main"], runner)) !== undefined;
    if (!reachable) throw new BootstrapFinalizeError("REACHABILITY_FAILED", "merged PR is not reachable from origin/main");
    return { ok: true, issueNumber, branch, candidateSha: merged.headSha, pr: merged.number, merged: true, reachable: true, issueClosed: issue.state === "CLOSED", worktreeRemoved: true, localBranchRemoved: true };
  }
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
  if ((await committedPaths(worktree, runner)).length === 0) throw new BootstrapFinalizeError("EMPTY_CANDIDATE", "candidate has no changes relative to origin/main");
  for (const check of REQUIRED_CHECKS) await sh(worktree, check, runner);
  say(`bootstrap finalize #${issueNumber} · candidate verified`);
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "commit") process.exit(99);
  await git(worktree, ["push", "-u", "origin", branch], runner);
  say(`bootstrap finalize #${issueNumber} · pushed ${branch}`);
  if (process.env.PI_NEXT_BOOTSTRAP_FINALIZE_CRASH_AFTER === "push") process.exit(99);
  let prs = await authority.listPullRequests(branch, root);
  if (prs.length > 1) throw new BootstrapFinalizeError("AMBIGUOUS_PR", `multiple PRs for ${branch}`);
  let pr = prs[0];
  if (pr && pr.headSha !== candidateSha && pr.state !== "MERGED") throw new BootstrapFinalizeError("PR_SHA_MISMATCH", "existing PR points to a different candidate SHA");
  if (!pr) pr = await authority.createPullRequest({ issue, branch, headSha: candidateSha, cwd: root });
  say(`bootstrap finalize #${issueNumber} · PR #${pr.number} ready`);
  if (pr.state !== "MERGED") {
    const checks = await authority.waitForChecks({ pr, headSha: candidateSha, cwd: root });
    if (checks !== "PASS") throw new BootstrapFinalizeError("CI_NOT_PASSING", `required CI ${checks}`);
    const remoteHead = await git(root, ["ls-remote", "origin", `refs/heads/${branch}`], runner);
    if (!remoteHead.startsWith(candidateSha)) throw new BootstrapFinalizeError("CANDIDATE_CHANGED", "branch changed while waiting for CI");
    say(`bootstrap finalize #${issueNumber} · CI PASS`);
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
  if (!issueClosed && authorityFingerprint(latest) !== initialAuthorityFingerprint) throw new BootstrapFinalizeError("STALE_AUTHORITY", "issue authority changed before closure");
  if (!issueClosed && !isExternalPending(latest)) { await authority.closeIssue(issueNumber, root); issueClosed = true; say(`bootstrap finalize #${issueNumber} · issue closed`); }
  if (!issueClosed && isExternalPending(latest)) throw new BootstrapFinalizeError("EXTERNAL_VERIFICATION_PENDING", "pending external verification remains open after integration");
  if ((await git(worktree, ["status", "--porcelain"], runner)) !== "") throw new BootstrapFinalizeError("UNIQUE_WORK_PRESENT", "refusing cleanup with dirty worktree");
  await git(root, ["worktree", "remove", worktree], runner);
  say(`bootstrap finalize #${issueNumber} · worktree removed`);
  let branchRemoved = false;
  if ((await tryGit(root, ["merge-base", "--is-ancestor", branch, "origin/main"], runner)) !== undefined) { await git(root, ["branch", "-d", branch], runner); branchRemoved = true; say(`bootstrap finalize #${issueNumber} · local branch removed`); }
  else throw new BootstrapFinalizeError("UNINTEGRATED_BRANCH", "local branch contains work not reachable from origin/main");
  try { if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true }); } catch {}
  say(`bootstrap finalize #${issueNumber} · PASS`);
  return { ok: true, issueNumber, branch, candidateSha, pr: pr.number, merged: true, reachable, issueClosed, worktreeRemoved: true, localBranchRemoved: branchRemoved };
}

function parseArgs(argv: string[]): { issueNumber?: number } { const out: { issueNumber?: number } = {}; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--issue") out.issueNumber = Number(argv[++i]); } return out; }
export async function main(argv = process.argv.slice(2)): Promise<void> { const args = parseArgs(argv); const report = await runBootstrapFinalize({ issueNumber: args.issueNumber, reporter: (l) => console.log(l) }); console.log(JSON.stringify({ bootstrapFinalize: report })); }

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { BootstrapFinalizeError, main as bootstrapFinalizeMain, runBootstrapFinalize, type BootstrapFinalizeAuthority, type BootstrapFinalizeIssue, type BootstrapFinalizePr } from "../scripts/bootstrap-finalize.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> { return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim(); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-finalize-"));
  const remote = `${root}.git`;
  await exec("git", ["init", "--initial-branch=main", root]);
  await git(root, "config", "user.email", "finalize@example.invalid");
  await git(root, "config", "user.name", "Finalize Test");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "true", test: "true" } }));
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await exec("git", ["init", "--bare", remote]);
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-q", "-u", "origin", "main");
  await mkdir(join(root, ".worktrees"));
  return { root, remote, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); } };
}

async function cleanCandidate(root: string, issue: number) {
  const path = join(root, ".worktrees", `issue-${issue}`);
  await git(root, "worktree", "add", "-q", "-b", `agent/issue-${issue}`, path, "origin/main");
  return path;
}

async function dirtyCandidate(root: string, issue: number, file = "feature.txt") {
  const path = await cleanCandidate(root, issue);
  await writeFile(join(path, file), "candidate\n");
  return path;
}

async function dirtyTrackedCandidate(root: string, issue: number, file = "README.md") {
  const path = join(root, ".worktrees", `issue-${issue}`);
  await git(root, "worktree", "add", "-q", "-b", `agent/issue-${issue}`, path, "origin/main");
  await writeFile(join(path, file), "candidate tracked change\n");
  return path;
}

class FakeAuthority implements BootstrapFinalizeAuthority {
  issue: BootstrapFinalizeIssue;
  prs: BootstrapFinalizePr[] = [];
  checks: "PASS" | "FAIL" = "PASS";
  closed = false;
  constructor(private root: string, issueNumber: number) { this.issue = { number: issueNumber, title: "feat(finalize): add helper", state: "OPEN" }; }
  async fetchIssue() { return { ...this.issue, state: this.closed ? "CLOSED" as const : this.issue.state }; }
  async listPullRequests(branch: string) { return this.prs.filter((p) => p.headRefName === branch); }
  async createPullRequest(input: { branch: string; headSha: string }) { const pr = { number: this.prs.length + 1, headRefName: input.branch, headSha: input.headSha, baseRefName: "main", state: "OPEN" as const }; this.prs.push(pr); return pr; }
  async waitForChecks() { return this.checks; }
  async mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string }) { await git(this.root, "fetch", "origin", input.pr.headRefName); await git(this.root, "switch", "main"); await git(this.root, "merge", "--ff-only", input.headSha); await git(this.root, "push", "-q", "origin", "main"); input.pr.state = "MERGED"; input.pr.mergeCommitSha = input.headSha; return input.pr; }
  async closeIssue() { this.closed = true; this.issue.state = "CLOSED"; }
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof BootstrapFinalizeError && error.code === code);
}

test("bootstrap finalizer commits, pushes, creates PR, merges, proves reachability, closes and cleans up", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.localBranchRemoved, true);
    assert.equal(authority.prs.length, 1);
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-101"));
    assert.match(await git(f.remote, "log", "--oneline", "-1", "main"), /feat\(finalize\): add helper \(#101\)/);
    assert.ok(lines.some((line) => line.endsWith("PASS")));
  } finally { await f.cleanup(); }
});

test("finalizer refuses open zero-delta candidate without creating empty commit or PR", async () => {
  const f = await fixture();
  try {
    await cleanCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    const before = await git(f.root, "rev-parse", "agent/issue-101");
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority }), "NO_CHANGE_CANDIDATE");
    assert.equal(await git(f.root, "rev-parse", "agent/issue-101"), before);
    assert.equal(authority.prs.length, 0);
    assert.equal(authority.closed, false);
  } finally { await f.cleanup(); }
});

test("finalizer treats closed zero-delta candidate as harmless already-satisfied cleanup without PR", async () => {
  const f = await fixture();
  try {
    await cleanCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.issue.state = "CLOSED";
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority });
    assert.equal(result.outcome, "already-satisfied");
    assert.equal(result.merged, false);
    assert.equal(result.issueClosed, true);
    assert.equal(authority.prs.length, 0);
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-101"));
  } finally { await f.cleanup(); }
});

test("explicit --issue selects one candidate when another candidate exists", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101, "a.txt");
    await dirtyCandidate(f.root, 102, "b.txt");
    const authority = new FakeAuthority(f.root, 102);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 102, authority });
    assert.equal(result.issueNumber, 102);
    assert.ok(await git(f.root, "rev-parse", "--verify", "agent/issue-101"));
  } finally { await f.cleanup(); }
});

test("multiple candidates without explicit issue fail closed", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101, "a.txt");
    await dirtyCandidate(f.root, 102, "b.txt");
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, authority: new FakeAuthority(f.root, 101) }), "AMBIGUOUS_CANDIDATE");
  } finally { await f.cleanup(); }
});

test("failed CI preserves worktree and prevents merge, closure, and cleanup", async () => {
  const f = await fixture();
  try {
    const worktree = await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.checks = "FAIL";
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, authority }), "CI_NOT_PASSING");
    assert.ok(await git(f.root, "rev-parse", "--verify", "agent/issue-101"));
    assert.equal(authority.closed, false);
    assert.equal(await git(f.remote, "rev-parse", "main"), await git(f.root, "rev-parse", "origin/main"));
    assert.ok(await git(worktree, "status", "--porcelain") === "");
  } finally { await f.cleanup(); }
});

test("first unstaged tracked candidate path preserves porcelain status columns", async () => {
  const f = await fixture();
  try {
    await dirtyTrackedCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    const result = await runBootstrapFinalize({ cwd: f.root, authority });
    assert.equal(result.ok, true);
    assert.equal(await git(f.remote, "show", "main:README.md"), "candidate tracked change");
  } finally { await f.cleanup(); }
});

test("automatic candidate discovery ignores stale already-integrated issue branches and worktrees", async () => {
  const f = await fixture();
  try {
    const stale = await dirtyCandidate(f.root, 100, "stale.txt");
    await git(stale, "add", "stale.txt");
    await git(stale, "commit", "-qm", "stale integrated");
    await git(f.root, "switch", "main");
    await git(f.root, "merge", "--ff-only", "agent/issue-100");
    await git(f.root, "push", "-q", "origin", "main");
    await dirtyCandidate(f.root, 101, "live.txt");
    const authority = new FakeAuthority(f.root, 101);
    const result = await runBootstrapFinalize({ cwd: f.root, authority });
    assert.equal(result.issueNumber, 101);
  } finally { await f.cleanup(); }
});

test("bootstrap finalizer --help reports usage without touching repository state", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
    await bootstrapFinalizeMain(["--help"]);
  } finally { console.log = originalLog; }
  assert.match(logs.join("\n"), /Usage: npm run bootstrap:finalize/);
  assert.match(logs.join("\n"), /--issue N/);
});

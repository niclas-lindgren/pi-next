import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { BootstrapFinalizeError, classifyCiEvidence, classifyExternalVerificationAuthority, evaluateGhPrChecks, main as bootstrapFinalizeMain, runBootstrapFinalize, type BootstrapFinalizeAuthority, type BootstrapFinalizeIssue, type BootstrapFinalizePr, type CheckConclusion, type CiEvaluation } from "../scripts/bootstrap-finalize.ts";

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

async function externallyMergedCandidate(root: string, remote: string, issue: number, file = "feature.txt") {
  const worktree = await dirtyCandidate(root, issue, file);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-qm", `candidate ${issue}`);
  const sha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-q", "-u", "origin", `agent/issue-${issue}`);
  await git(root, "switch", "main");
  await git(root, "merge", "--ff-only", sha);
  await git(root, "push", "-q", "origin", "main");
  assert.equal(await git(remote, "rev-parse", "main"), sha);
  return { worktree, sha, pr: { number: issue, headRefName: `agent/issue-${issue}`, headSha: sha, baseRefName: "main", state: "MERGED" as const, mergeCommitSha: sha } };
}

class FakeAuthority implements BootstrapFinalizeAuthority {
  issue: BootstrapFinalizeIssue;
  prs: BootstrapFinalizePr[] = [];
  checks: CheckConclusion | CiEvaluation | Array<CheckConclusion | CiEvaluation> = "PASS";
  closed = false;
  createdPrs = 0;
  mergedPrs = 0;
  waitedForChecks = 0;
  constructor(private root: string, issueNumber: number) { this.issue = { number: issueNumber, title: "feat(finalize): add helper", state: "OPEN" }; }
  async fetchIssue() { return { ...this.issue, state: this.closed ? "CLOSED" as const : this.issue.state }; }
  async listPullRequests(branch: string) { return this.prs.filter((p) => p.headRefName === branch); }
  async createPullRequest(input: { branch: string; headSha: string }) { this.createdPrs++; const pr = { number: this.prs.length + 1, headRefName: input.branch, headSha: input.headSha, baseRefName: "main", state: "OPEN" as const }; this.prs.push(pr); return pr; }
  async waitForChecks(input: { reporter?: (line: string) => void; issueNumber?: number }) {
    this.waitedForChecks++;
    if (Array.isArray(this.checks)) {
      for (let i = 0; i < this.checks.length; i++) {
        const value = this.checks[i]!;
        if ((typeof value === "string" ? value : value.state) !== "PENDING") return value;
        input.reporter?.(`bootstrap finalize #${input.issueNumber ?? this.issue.number} · CI · waiting · elapsed=${i}s`);
      }
      return "TIMEOUT" as const;
    }
    const value = this.checks;
    if ((typeof value === "string" ? value : value.state) === "PENDING") input.reporter?.(`bootstrap finalize #${input.issueNumber ?? this.issue.number} · CI · waiting · elapsed=0s`);
    return value;
  }
  async mergePullRequest(input: { pr: BootstrapFinalizePr; headSha: string }) { this.mergedPrs++; await git(this.root, "fetch", "origin", input.pr.headRefName); await git(this.root, "switch", "main"); await git(this.root, "merge", "--ff-only", input.headSha); await git(this.root, "push", "-q", "origin", "main"); input.pr.state = "MERGED"; input.pr.mergeCommitSha = input.headSha; return input.pr; }
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

test("externally merged candidate with worktree still present resumes post-merge cleanup instead of zero-delta rejection", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedCandidate(f.root, f.remote, 77);
    const authority = new FakeAuthority(f.root, 77);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 77, authority });
    assert.equal(result.outcome, "finalized");
    assert.equal(result.candidateSha, sha);
    assert.equal(result.pr, 77);
    assert.equal(result.issueClosed, true);
    assert.equal(authority.closed, true);
    assert.equal(authority.createdPrs, 0);
    assert.equal(authority.waitedForChecks, 0);
    assert.equal(authority.mergedPrs, 0);
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-77"));
  } finally { await f.cleanup(); }
});

test("externally merged zero-diff candidate proves exact head reachability before cleanup", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedCandidate(f.root, f.remote, 118);
    const authority = new FakeAuthority(f.root, 118);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 118, authority });
    assert.equal(result.reachable, true);
    assert.equal(await git(f.remote, "merge-base", "--is-ancestor", sha, "main").then(() => "yes"), "yes");
  } finally { await f.cleanup(); }
});

test("issue 119 prose mentioning pending external verification does not block exact merged recovery", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedCandidate(f.root, f.remote, 119);
    const authority = new FakeAuthority(f.root, 119);
    authority.issue.body = [
      "honor pending external verification and changed-authority rules",
      "",
      "pending external verification remains open and cleanup behavior follows repository lifecycle policy",
    ].join("\n");
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 119, authority });
    assert.equal(result.issueClosed, true);
    assert.equal(authority.closed, true);
  } finally { await f.cleanup(); }
});

test("explicit structured pending external verification marker leaves integrated issue open but cleans worktree", async () => {
  const f = await fixture();
  try {
    const { pr, worktree } = await externallyMergedCandidate(f.root, f.remote, 122);
    const authority = new FakeAuthority(f.root, 122);
    authority.issue.comments = [{ id: "pending", body: pendingMarker }];
    authority.prs.push(pr);
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 122, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.outcome, "integrated-pending-verification");
    assert.equal(result.issueClosed, false);
    assert.equal(result.pendingExternalVerification, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.localBranchRemoved, true);
    assert.equal(authority.closed, false);
    await assert.rejects(git(worktree, "status", "--porcelain"));
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-122"));
    assert.ok(lines.includes("bootstrap finalize #122 · external verification pending · issue remains open"));
    assert.ok(lines.includes("bootstrap finalize #122 · INTEGRATED_PENDING_VERIFICATION"));
  } finally { await f.cleanup(); }
});

test("pending integrated finalization rerun is idempotent after worktree and branch cleanup", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedCandidate(f.root, f.remote, 123);
    const authority = new FakeAuthority(f.root, 123);
    authority.issue.comments = [{ id: "pending", body: pendingMarker }];
    authority.prs.push(pr);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 123, authority });
    const rerun = await runBootstrapFinalize({ cwd: f.root, issueNumber: 123, authority });
    assert.equal(rerun.outcome, "integrated-pending-verification");
    assert.equal(rerun.worktreeRemoved, true);
    assert.equal(rerun.localBranchRemoved, true);
    assert.equal(authority.closed, false);
  } finally { await f.cleanup(); }
});

test("local branch is preserved when merged PR is not reachable from origin main", async () => {
  const f = await fixture();
  try {
    const worktree = await dirtyCandidate(f.root, 124);
    await git(worktree, "add", "feature.txt");
    await git(worktree, "commit", "-qm", "candidate 124");
    const sha = await git(worktree, "rev-parse", "HEAD");
    const authority = new FakeAuthority(f.root, 124);
    authority.prs.push({ number: 124, headRefName: "agent/issue-124", headSha: sha, baseRefName: "main", state: "MERGED", mergeCommitSha: sha });
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 124, authority }), "REACHABILITY_FAILED");
    assert.equal(await git(f.root, "rev-parse", "--verify", "agent/issue-124"), sha);
    assert.equal(await git(worktree, "rev-parse", "HEAD"), sha);
  } finally { await f.cleanup(); }
});

test("successful external verification can close without recreating old worktree", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedCandidate(f.root, f.remote, 125);
    const authority = new FakeAuthority(f.root, 125);
    authority.issue.comments = [{ id: "pending", body: pendingMarkerFor(pr.headSha) }];
    authority.prs.push(pr);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 125, authority });
    authority.issue.comments = [{ id: "pending", body: pendingMarkerFor(pr.headSha) }, { id: "pass", body: resultMarkerFor(pr.headSha, "passed") }];
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 125, authority });
    assert.equal(result.outcome, "finalized");
    assert.equal(result.issueClosed, true);
    assert.equal(authority.closed, true);
  } finally { await f.cleanup(); }
});

test("failed external verification does not close and allows a fresh branch from current main", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedCandidate(f.root, f.remote, 126);
    const authority = new FakeAuthority(f.root, 126);
    authority.issue.comments = [{ id: "pending", body: pendingMarkerFor(pr.headSha) }];
    authority.prs.push(pr);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 126, authority });
    authority.issue.comments = [{ id: "pending", body: pendingMarkerFor(pr.headSha) }, { id: "fail", body: resultMarkerFor(pr.headSha, "failed") }];
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 126, authority }), "EXTERNAL_VERIFICATION_FAILED");
    assert.equal(authority.closed, false);
    const fresh = await cleanCandidate(f.root, 126);
    assert.equal(await git(fresh, "rev-parse", "HEAD"), await git(f.root, "rev-parse", "origin/main"));
  } finally { await f.cleanup(); }
});

test("dirty unique work appearing after external merge blocks cleanup", async () => {
  const f = await fixture();
  try {
    const { worktree, pr } = await externallyMergedCandidate(f.root, f.remote, 119);
    await writeFile(join(worktree, "unique.txt"), "do not delete\n");
    const authority = new FakeAuthority(f.root, 119);
    authority.prs.push(pr);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 119, authority }), "UNIQUE_WORK_PRESENT");
    assert.equal(await git(worktree, "status", "--porcelain"), "?? unique.txt");
  } finally { await f.cleanup(); }
});

test("historical merged PR on reused issue branch with different head SHA is ignored for current candidate", async () => {
  const f = await fixture();
  try {
    const historical = await externallyMergedCandidate(f.root, f.remote, 120, "old.txt");
    await git(f.root, "worktree", "remove", historical.worktree);
    await git(f.root, "branch", "-d", "agent/issue-120");
    await git(f.root, "worktree", "add", "-q", "-b", "agent/issue-120", join(f.root, ".worktrees", "issue-120"), "origin/main");
    await writeFile(join(f.root, ".worktrees", "issue-120", "new.txt"), "new candidate\n");
    await git(join(f.root, ".worktrees", "issue-120"), "add", "new.txt");
    await git(join(f.root, ".worktrees", "issue-120"), "commit", "-qm", "new candidate");
    const authority = new FakeAuthority(f.root, 120);
    authority.prs.push({ ...historical.pr, number: 12 });
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 120, authority });
    assert.equal(result.pr, 2);
    assert.equal(authority.createdPrs, 1);
  } finally { await f.cleanup(); }
});

test("multiple merged PRs without local exact candidate identity fail closed", async () => {
  const f = await fixture();
  try {
    const one = await externallyMergedCandidate(f.root, f.remote, 121, "one.txt");
    await git(f.root, "worktree", "remove", one.worktree);
    await git(f.root, "branch", "-d", "agent/issue-121");
    const authority = new FakeAuthority(f.root, 121);
    authority.prs.push(one.pr, { ...one.pr, number: 122, headSha: await git(f.root, "rev-parse", "main"), mergeCommitSha: await git(f.root, "rev-parse", "main") });
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 121, authority }), "AMBIGUOUS_PR");
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

test("no checks configured or reported proceeds without reporting required CI FAIL", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 112);
    const authority = new FakeAuthority(f.root, 112);
    authority.checks = { state: "NONE", reason: "candidate efeb39b had no workflow runs/status contexts" };
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 112, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.ok(lines.includes("bootstrap finalize #112 · CI · no required checks"));
    assert.doesNotMatch(lines.join("\n"), /required CI FAIL/);
  } finally { await f.cleanup(); }
});

test("missing required checks fail with explicit CI_MISSING rather than ordinary CI_FAIL", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.checks = { state: "MISSING", reason: "required checks missing: npm test" };
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority }), "CI_MISSING");
    assert.equal(authority.closed, false);
  } finally { await f.cleanup(); }
});

test("CI unknown transport state fails closed distinctly", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.checks = { state: "UNKNOWN", reason: "gh pr checks unavailable" };
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority }), "CI_UNKNOWN");
  } finally { await f.cleanup(); }
});

test("pending CI progress is observable and can resolve on a bounded retry", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.checks = [{ state: "PENDING", reason: "queued" }, "PASS"];
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.ok(lines.some((line) => /CI · waiting · elapsed=0s/.test(line)));
    assert.ok(lines.includes("bootstrap finalize #101 · CI · PASS"));
  } finally { await f.cleanup(); }
});

test("unresolved pending CI times out and preserves the candidate", async () => {
  const f = await fixture();
  try {
    const worktree = await dirtyCandidate(f.root, 101);
    const authority = new FakeAuthority(f.root, 101);
    authority.checks = [{ state: "PENDING", reason: "queued" }, { state: "PENDING", reason: "running" }];
    const lines: string[] = [];
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority, reporter: (line) => lines.push(line) }), "CI_NOT_PASSING");
    assert.ok(lines.some((line) => /CI · waiting · elapsed=0s/.test(line)));
    assert.ok(lines.some((line) => /CI · waiting · elapsed=1s/.test(line)));
    assert.ok(await git(worktree, "status", "--porcelain") === "");
  } finally { await f.cleanup(); }
});

test("CI evidence classifier distinguishes absence, missing policy, failures, pending, pass, and unknown", () => {
  assert.deepEqual(classifyCiEvidence({ checkRows: [], requiredContexts: [], noChecksCliExit: true }).state, "NONE");
  assert.deepEqual(classifyCiEvidence({ checkRows: [], requiredContexts: ["npm test"] }).state, "MISSING");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", state: "FAIL" }], requiredContexts: ["npm test"] }).state, "FAIL");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", state: "SUCCESS" }], requiredContexts: ["npm test"] }).state, "PASS");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", state: "QUEUED" }], requiredContexts: ["npm test"] }).state, "PENDING");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", conclusion: "CANCELLED" }], requiredContexts: ["npm test"] }).state, "FAIL");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", state: "COMPLETED" }], requiredContexts: ["npm test"] }).state, "UNKNOWN");
  assert.deepEqual(classifyCiEvidence({ checkRows: [{ name: "npm test", state: "???" }], requiredContexts: ["npm test"] }).state, "UNKNOWN");
  assert.deepEqual(classifyCiEvidence({ checkRows: [], checksUnavailable: true }).state, "UNKNOWN");
});

test("gh pr checks adapter uses supported fields and treats no-check CLI non-zero as NONE", async () => {
  const calls: string[][] = [];
  const result = await evaluateGhPrChecks({
    cwd: "/tmp/repo",
    prNumber: 112,
    requiredContexts: [],
    runCommand: async (command, args, options) => {
      calls.push([command, ...args]);
      assert.equal(options.cwd, "/tmp/repo");
      if (args.includes("name,state,conclusion,bucket")) {
        return { command, args, cwd: options.cwd, exitCode: 1, stdout: "", stderr: `Unknown JSON field: "conclusion"\nAvailable fields:\n  bucket\n  completedAt\n  description\n  event\n  link\n  name\n  startedAt\n  state\n  workflow\n` };
      }
      assert.ok(args.includes("name,state,bucket"));
      return { command, args, cwd: options.cwd, exitCode: 1, stdout: "", stderr: "no checks reported on the 'agent/issue-107' branch" };
    },
  });
  assert.deepEqual(result, { state: "NONE", reason: "no checks reported by GitHub CLI" });
  assert.deepEqual(calls, [["gh", "pr", "checks", "112", "--json", "name,state,bucket"]]);
});

test("gh pr checks adapter classifies actual supported bucket field without conclusion", async () => {
  const result = await evaluateGhPrChecks({
    cwd: "/tmp/repo",
    prNumber: 101,
    requiredContexts: ["npm test"],
    runCommand: async (command, args, options) => ({ command, args, cwd: options.cwd, exitCode: 0, stdout: JSON.stringify([{ name: "npm test", state: "COMPLETED", bucket: "fail" }]), stderr: "" }),
  });
  assert.equal(result.state, "FAIL");
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

function externalIssue(body: string, comments: unknown[] = []): BootstrapFinalizeIssue { return { number: 119, title: "authority regression", state: "OPEN", body, comments }; }
const pendingRecord = { version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "verify deployed revision", environment: "production" }], integratedMainSha: "a".repeat(40) };
const pendingMarker = `<!-- pi-next-pending-verification -->\n${JSON.stringify(pendingRecord)}`;
const passedMarker = `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha: pendingRecord.integratedMainSha, status: "passed", evidence: "operator approved" })}`;
function pendingMarkerFor(integratedMainSha: string): string { return `<!-- pi-next-pending-verification -->\n${JSON.stringify({ ...pendingRecord, integratedMainSha })}`; }
function resultMarkerFor(integratedMainSha: string, status: "passed" | "failed"): string { return `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha, status, evidence: "operator evidence" })}`; }

test("external verification classifier ignores ordinary prose, checklists, code fences, and historical discussion", () => {
  assert.equal(classifyExternalVerificationAuthority(externalIssue("This spec says pending external verification remains open after integration.")), "clear");
  assert.equal(classifyExternalVerificationAuthority(externalIssue("## Tests\n- pending external verification remains open and cleanup behavior follows policy")), "clear");
  assert.equal(classifyExternalVerificationAuthority(externalIssue("```text\npending external verification\nawaiting external verification\npost-deploy verification\n```")), "clear");
  assert.equal(classifyExternalVerificationAuthority(externalIssue("", [{ id: "c1", body: "Historical note: pending external verification used to be phrase-matched." }])), "clear");
});

test("external verification classifier requires an explicit structured pending marker", () => {
  assert.equal(classifyExternalVerificationAuthority(externalIssue("", [{ id: "p", body: pendingMarker }])), "pending");
  assert.equal(classifyExternalVerificationAuthority(externalIssue("Unrelated prose says pending external verification.", [{ id: "p", body: pendingMarker }])), "pending");
});

test("external verification classifier fails closed for malformed or conflicting markers", () => {
  assert.throws(() => classifyExternalVerificationAuthority(externalIssue("", [{ id: "bad", body: "<!-- pi-next-pending-verification -->\nnot json" }])), (error) => error instanceof BootstrapFinalizeError && error.code === "EXTERNAL_VERIFICATION_AUTHORITY_INVALID");
  const other = { ...pendingRecord, integratedMainSha: "b".repeat(40) };
  assert.throws(() => classifyExternalVerificationAuthority(externalIssue("", [{ id: "p1", body: pendingMarker }, { id: "p2", body: `<!-- pi-next-pending-verification -->\n${JSON.stringify(other)}` }])), (error) => error instanceof BootstrapFinalizeError && error.code === "EXTERNAL_VERIFICATION_AUTHORITY_INVALID");
});

test("external verification classifier clears pending state with authoritative result marker", () => {
  assert.equal(classifyExternalVerificationAuthority(externalIssue("", [{ id: "p", body: pendingMarker }, { id: "r", body: passedMarker }])), "clear");
});

test("external verification classifier reproduces issue 119 false-positive body as clear without model calls", () => {
  const body = [
    "honor pending external verification and changed-authority rules",
    "",
    "```text",
    "pending external verification remains open and cleanup behavior follows repository lifecycle policy",
    "```",
  ].join("\n");
  assert.equal(classifyExternalVerificationAuthority(externalIssue(body)), "clear");
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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { BootstrapFinalizeError, classifyCiEvidence, classifyExternalVerificationAuthority, evaluateGhPrChecks, main as bootstrapFinalizeMain, runBootstrapFinalize, type BootstrapFinalizeAuthority, type BootstrapFinalizeIssue, type BootstrapFinalizePr, type CheckConclusion, type CiEvaluation, type CommandRunner } from "../scripts/bootstrap-finalize.ts";
import { readCandidateState } from "../src/bootstrap/candidate.ts";
import { runCommand as bootstrapRunCommand } from "../src/bootstrap/command-runner.ts";
import { LifecycleCheckpointFault, withLifecycleFaultInjection } from "../src/coordination/lifecycle-checkpoints.ts";

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

async function externallyMergedRemoteOnly(root: string, remote: string, issue: number, file = `feature-${issue}.txt`) {
  const worktree = await dirtyCandidate(root, issue, file);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-qm", `candidate ${issue}`);
  const sha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-q", "-u", "origin", `agent/issue-${issue}`);
  await git(remote, "update-ref", "refs/heads/main", sha);
  assert.notEqual(await git(root, "rev-parse", "main"), sha);
  return { worktree, sha, pr: { number: issue, headRefName: `agent/issue-${issue}`, headSha: sha, baseRefName: "main", state: "MERGED" as const, mergeCommitSha: sha } };
}

class FakeAuthority implements BootstrapFinalizeAuthority {
  issue: BootstrapFinalizeIssue;
  prs: BootstrapFinalizePr[] = [];
  checks: CheckConclusion | CiEvaluation | Array<CheckConclusion | CiEvaluation> = "PASS";
  closed = false;
  createdPrs = 0;
  mergedPrs = 0;
  closeCalls = 0;
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
  async closeIssue() { this.closeCalls++; this.closed = true; this.issue.state = "CLOSED"; }
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

test("finalizer accepts a verified file inside a newly untracked directory", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1411);
    await mkdir(join(worktree, "docs", "evaluation"), { recursive: true });
    await writeFile(join(worktree, "docs", "evaluation", "one.json"), "{}\n");
    const authority = new FakeAuthority(f.root, 1411);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 1411, authority, candidatePaths: ["docs/evaluation/one.json"] });
    assert.equal(result.issueClosed, true);
    assert.equal(await git(f.remote, "show", "main:docs/evaluation/one.json"), "{}");
  } finally { await f.cleanup(); }
});

test("finalizer keeps multiple files under one new untracked directory at file granularity", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1412);
    await mkdir(join(worktree, "test", "fixtures", "worker-canaries"), { recursive: true });
    await writeFile(join(worktree, "test", "fixtures", "worker-canaries", "README.md"), "readme\n");
    await writeFile(join(worktree, "test", "fixtures", "worker-canaries", "case.json"), "{}\n");
    const authority = new FakeAuthority(f.root, 1412);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 1412, authority, candidatePaths: ["test/fixtures/worker-canaries/README.md", "test/fixtures/worker-canaries/case.json"] });
    assert.equal(await git(f.remote, "show", "main:test/fixtures/worker-canaries/README.md"), "readme");
    assert.equal(await git(f.remote, "show", "main:test/fixtures/worker-canaries/case.json"), "{}");
  } finally { await f.cleanup(); }
});

test("candidate inspection and finalization share deterministic file-level paths across independent untracked directories", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1413);
    await mkdir(join(worktree, "z-dir"), { recursive: true });
    await mkdir(join(worktree, "a-dir"), { recursive: true });
    await writeFile(join(worktree, "z-dir", "z.txt"), "z\n");
    await writeFile(join(worktree, "a-dir", "a.txt"), "a\n");
    const baseline = await git(worktree, "rev-parse", "origin/main");
    const candidate = await readCandidateState(worktree, baseline, bootstrapRunCommand);
    assert.deepEqual(candidate.changedFiles, ["a-dir/a.txt", "z-dir/z.txt"]);
    const authority = new FakeAuthority(f.root, 1413);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 1413, authority, candidatePaths: candidate.changedFiles });
    assert.equal(await git(f.remote, "show", "main:a-dir/a.txt"), "a");
    assert.equal(await git(f.remote, "show", "main:z-dir/z.txt"), "z");
  } finally { await f.cleanup(); }
});

test("finalizer rejects an unrelated untracked file outside verified candidate paths", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1414);
    await writeFile(join(worktree, "candidate.txt"), "candidate\n");
    await writeFile(join(worktree, "scratch.txt"), "scratch\n");
    const authority = new FakeAuthority(f.root, 1414);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1414, authority, candidatePaths: ["candidate.txt"] }), "UNKNOWN_CHANGES");
    assert.equal(authority.prs.length, 0);
  } finally { await f.cleanup(); }
});

test("finalizer rejects an unrelated tracked modification outside verified candidate paths", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1415);
    await writeFile(join(worktree, "candidate.txt"), "candidate\n");
    await writeFile(join(worktree, "README.md"), "unrelated tracked\n");
    const authority = new FakeAuthority(f.root, 1415);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1415, authority, candidatePaths: ["candidate.txt"] }), "UNKNOWN_CHANGES");
    assert.equal(authority.prs.length, 0);
  } finally { await f.cleanup(); }
});

test("staged, unstaged and untracked candidate paths normalize consistently from inspection to finalization", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1416);
    await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { typecheck: "true", test: "true" }, changed: true }));
    await git(worktree, "add", "package.json");
    await writeFile(join(worktree, "README.md"), "unstaged tracked\n");
    await mkdir(join(worktree, "nested"), { recursive: true });
    await writeFile(join(worktree, "nested", "new.txt"), "new\n");
    const baseline = await git(worktree, "rev-parse", "origin/main");
    const candidate = await readCandidateState(worktree, baseline, bootstrapRunCommand);
    assert.deepEqual(candidate.changedFiles, ["README.md", "nested/new.txt", "package.json"]);
    const authority = new FakeAuthority(f.root, 1416);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 1416, authority, candidatePaths: candidate.changedFiles });
    assert.equal(await git(f.remote, "show", "main:nested/new.txt"), "new");
  } finally { await f.cleanup(); }
});

test("rename candidate path handling remains the destination path", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1417);
    await mkdir(join(worktree, "docs"), { recursive: true });
    await git(worktree, "mv", "README.md", "docs/RENAMED.md");
    const authority = new FakeAuthority(f.root, 1417);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 1417, authority, candidatePaths: ["docs/RENAMED.md"] });
    assert.equal(await git(f.remote, "show", "main:docs/RENAMED.md"), "base");
  } finally { await f.cleanup(); }
});

test("explicit staging refuses to stage paths beyond the verified set", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1418);
    await writeFile(join(worktree, "intended.txt"), "intended\n");
    await mkdir(join(worktree, "extra"), { recursive: true });
    await writeFile(join(worktree, "extra", "unknown.txt"), "unknown\n");
    const authority = new FakeAuthority(f.root, 1418);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1418, authority, candidatePaths: ["intended.txt"] }), "UNKNOWN_CHANGES");
    assert.equal(await git(worktree, "status", "--porcelain", "intended.txt"), "?? intended.txt");
    assert.equal(authority.createdPrs, 0);
  } finally { await f.cleanup(); }
});

test("#81 bootstrap path shape finalizes without untracked directory placeholders", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1419);
    await mkdir(join(worktree, "docs", "evaluation"), { recursive: true });
    await mkdir(join(worktree, "scripts"), { recursive: true });
    await mkdir(join(worktree, "src", "evaluation"), { recursive: true });
    await mkdir(join(worktree, "test", "fixtures", "worker-canaries"), { recursive: true });
    await writeFile(join(worktree, "docs", "EVALUATION_AND_RELIABILITY.md"), "eval\n");
    await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { typecheck: "true", test: "true" }, dependencies: {} }));
    await writeFile(join(worktree, "src", "evaluation", "index.ts"), "export {};\n");
    await writeFile(join(worktree, "test", "bootstrap-self-host.test.ts"), "test\n");
    await writeFile(join(worktree, "docs", "evaluation", "pi-worker-baseline.initial.json"), "{}\n");
    await writeFile(join(worktree, "scripts", "eval-worker.ts"), "export {};\n");
    await writeFile(join(worktree, "src", "evaluation", "pi-worker-adapter.ts"), "export {};\n");
    await writeFile(join(worktree, "src", "evaluation", "worker-canaries.ts"), "export {};\n");
    await writeFile(join(worktree, "test", "fixtures", "worker-canaries", "README.md"), "canary\n");
    await writeFile(join(worktree, "test", "worker-canaries.test.ts"), "test\n");
    const paths = [
      "docs/EVALUATION_AND_RELIABILITY.md",
      "package.json",
      "src/evaluation/index.ts",
      "test/bootstrap-self-host.test.ts",
      "docs/evaluation/pi-worker-baseline.initial.json",
      "scripts/eval-worker.ts",
      "src/evaluation/pi-worker-adapter.ts",
      "src/evaluation/worker-canaries.ts",
      "test/fixtures/worker-canaries/README.md",
      "test/worker-canaries.test.ts",
    ];
    const authority = new FakeAuthority(f.root, 1419);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 1419, authority, candidatePaths: paths });
    assert.equal(await git(f.remote, "show", "main:docs/evaluation/pi-worker-baseline.initial.json"), "{}");
    assert.equal(await git(f.remote, "show", "main:test/fixtures/worker-canaries/README.md"), "canary");
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

test("crash after reachability before authority reconciliation resumes without duplicate merge or premature close", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 201);
    const authority = new FakeAuthority(f.root, 201);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "authority_reconciled", position: "before" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 201, authority }),
      ),
      (error: unknown) => error instanceof LifecycleCheckpointFault
        && error.checkpoint === "authority_reconciled"
        && error.position === "before",
    );
    assert.equal(authority.mergedPrs, 1);
    assert.equal(authority.closeCalls, 0);
    assert.equal(await git(f.remote, "merge-base", "--is-ancestor", "agent/issue-201", "main").then(() => "yes"), "yes");
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-201")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 201, authority });
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(authority.mergedPrs, 1);
    assert.equal(authority.closeCalls, 1);
  } finally { await f.cleanup(); }
});

test("crash after close before cleanup resumes without duplicate close", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 202);
    const authority = new FakeAuthority(f.root, 202);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "issue_closed", position: "after" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 202, authority }),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal(authority.closeCalls, 1);
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-202")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 202, authority });
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(authority.closeCalls, 1);
    assert.equal(authority.mergedPrs, 1);
  } finally { await f.cleanup(); }
});

test("pending external verification crash before cleanup does not close or resurrect implementation", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedCandidate(f.root, f.remote, 203);
    const authority = new FakeAuthority(f.root, 203);
    authority.prs.push(pr);
    authority.issue.comments = [{ body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "deploy", environment: "staging" }], integratedMainSha: sha })}` }];
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "workspace_cleaned", position: "before" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 203, authority }),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal(authority.closeCalls, 0);
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-203")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 203, authority });
    assert.equal(result.outcome, "integrated-pending-verification");
    assert.equal(result.issueClosed, false);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(authority.createdPrs, 0);
    assert.equal(authority.mergedPrs, 0);
    assert.equal(authority.closeCalls, 0);
  } finally { await f.cleanup(); }
});

test("cleanup retry preserves unique dirty work after interruption", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 204);
    const authority = new FakeAuthority(f.root, 204);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "workspace_cleaned", position: "before" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 204, authority }),
      ),
      LifecycleCheckpointFault,
    );
    const worktree = join(f.root, ".worktrees", "issue-204");
    await writeFile(join(worktree, "unique.txt"), "preserve me\n");
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 204, authority }), "UNIQUE_WORK_PRESENT");
    assert.equal(await git(worktree, "status", "--porcelain"), "?? unique.txt");
    assert.equal(authority.closeCalls, 1);
  } finally { await f.cleanup(); }
});

test("finalizer fast-forwards a clean stale local main after reachability and cleanup", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedRemoteOnly(f.root, f.remote, 133);
    const authority = new FakeAuthority(f.root, 133);
    authority.prs.push(pr);
    const lines: string[] = [];
    const commands: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      commands.push([command, ...args].join(" "));
      try {
        const { stdout, stderr } = await exec(command, args, { cwd: options.cwd, encoding: "utf8" });
        return { command, args, cwd: options.cwd, exitCode: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { command, args, cwd: options.cwd, exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
      }
    };
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 133, authority, reporter: (line) => lines.push(line), runCommand: runner });
    assert.ok(commands.some((command) => command.includes(" merge --ff-only origin/main")));
    assert.equal(commands.some((command) => /\smerge\s(?!.*--ff-only)/.test(command)), false);
    assert.equal(commands.some((command) => /\srebase\s/.test(command)), false);
    assert.equal(commands.some((command) => /\sreset\s/.test(command)), false);
    assert.equal(result.localMainSync?.status, "fast-forwarded");
    assert.equal(await git(f.root, "rev-parse", "main"), sha);
    assert.equal(await git(f.root, "rev-parse", "origin/main"), sha);
    assert.ok(lines.indexOf("bootstrap finalize #133 · reachable from origin/main") < lines.indexOf("bootstrap finalize #133 · local main fast-forwarded"));
    assert.ok(lines.indexOf("bootstrap finalize #133 · worktree removed") < lines.indexOf("bootstrap finalize #133 · local main fast-forwarded"));
  } finally { await f.cleanup(); }
});

test("finalizer local-main sync is idempotent when main is already current", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedCandidate(f.root, f.remote, 134);
    const authority = new FakeAuthority(f.root, 134);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 134, authority });
    assert.equal(result.localMainSync?.status, "already-current");
    assert.equal(await git(f.root, "rev-parse", "main"), sha);
  } finally { await f.cleanup(); }
});

test("dirty root checkout skips local-main sync without losing work or undoing finalization", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedRemoteOnly(f.root, f.remote, 135);
    await writeFile(join(f.root, "README.md"), "local dirty work\n");
    const authority = new FakeAuthority(f.root, 135);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 135, authority });
    assert.equal(result.outcome, "finalized");
    assert.equal(result.localMainSync?.status, "skipped");
    assert.equal(result.localMainSync.reason, "dirty root checkout");
    assert.equal(await git(f.root, "status", "--porcelain"), "M README.md");
    assert.match(await git(f.root, "diff", "--", "README.md"), /local dirty work/);
  } finally { await f.cleanup(); }
});

test("diverged or ahead local main is not reset, rebased, or merged during convenience sync", async () => {
  const f = await fixture();
  try {
    const { pr } = await externallyMergedRemoteOnly(f.root, f.remote, 136);
    await writeFile(join(f.root, "local.txt"), "unique local main\n");
    await git(f.root, "add", "local.txt");
    await git(f.root, "commit", "-qm", "unique local main");
    const localMain = await git(f.root, "rev-parse", "main");
    const authority = new FakeAuthority(f.root, 136);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 136, authority });
    assert.equal(result.localMainSync?.status, "skipped");
    assert.equal(await git(f.root, "rev-parse", "main"), localMain);
    assert.equal(await git(f.root, "rev-list", "--parents", "-n", "1", "main").then((line) => line.split(" ").length), 2);
  } finally { await f.cleanup(); }
});

test("root checkout on another branch is not switched while local main ref fast-forwards", async () => {
  const f = await fixture();
  try {
    const { sha, pr } = await externallyMergedRemoteOnly(f.root, f.remote, 137);
    await git(f.root, "switch", "-c", "operator-topic");
    const authority = new FakeAuthority(f.root, 137);
    authority.prs.push(pr);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 137, authority });
    assert.equal(result.localMainSync?.status, "fast-forwarded");
    assert.equal(await git(f.root, "branch", "--show-current"), "operator-topic");
    assert.equal(await git(f.root, "rev-parse", "main"), sha);
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

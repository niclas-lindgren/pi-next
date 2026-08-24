import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { BootstrapFinalizeError, main as bootstrapFinalizeMain, runBootstrapFinalize, type CommandRunner } from "../scripts/bootstrap-finalize.ts";
import { readCandidateState } from "../src/bootstrap/candidate.ts";
import { runCommand as bootstrapRunCommand } from "../src/bootstrap/command-runner.ts";
import { LifecycleCheckpointFault, withLifecycleFaultInjection } from "../src/coordination/lifecycle-checkpoints.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";

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

/**
 * Simulates a candidate that a prior finalize run already pushed directly to
 * origin/main (no PR) via a real --no-ff merge, exactly like finalizeIssue()
 * itself performs. Returns both the candidate's own feature commit (`sha`,
 * what runBootstrapFinalize reports as candidateSha) and the resulting merge
 * commit (`mergeSha`, what `main`'s tip actually becomes) - callers checking
 * against `main`'s tip must use `mergeSha`, not `sha`.
 */
async function directlyIntegratedCandidate(root: string, remote: string, issue: number, file = "feature.txt") {
  const worktree = await dirtyCandidate(root, issue, file);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-qm", `candidate ${issue}`);
  const sha = await git(worktree, "rev-parse", "HEAD");
  await git(root, "fetch", "origin", "main");
  await git(root, "switch", "main");
  await git(root, "merge", "--no-ff", "--no-edit", sha);
  await git(root, "push", "-q", "origin", "main");
  const mergeSha = await git(root, "rev-parse", "main");
  assert.equal(await git(remote, "rev-parse", "main"), mergeSha);
  return { worktree, sha, mergeSha };
}

/**
 * Simulates the same real --no-ff integration as directlyIntegratedCandidate,
 * but performed in a scratch worktree pushed straight to the bare remote, so
 * `root`'s own local `main` branch ref has not caught up yet (only its
 * origin/main remote-tracking ref will, once it fetches). The merge commit
 * this produces is a distinct SHA from the candidate's own commit, unlike a
 * bare fast-forward - which is what makes "already integrated" mechanically
 * provable at all without external (e.g. PR) evidence.
 */
async function directlyIntegratedRemoteOnly(root: string, _remote: string, issue: number, file = `feature-${issue}.txt`) {
  const worktree = await dirtyCandidate(root, issue, file);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-qm", `candidate ${issue}`);
  const sha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-q", "-u", "origin", `agent/issue-${issue}`);
  const scratch = `${worktree}-scratch-main`;
  await git(root, "worktree", "add", "-q", scratch, "origin/main");
  await git(scratch, "merge", "--no-ff", "--no-edit", sha);
  const mergeSha = await git(scratch, "rev-parse", "HEAD");
  await git(scratch, "push", "-q", "origin", "HEAD:main");
  await git(root, "worktree", "remove", scratch);
  assert.notEqual(await git(root, "rev-parse", "main"), mergeSha);
  return { worktree, sha: mergeSha };
}

/**
 * finalizeIssue() re-records its own pendingVerification with the exact
 * mergeSha it just integrated, overwriting whatever integratedMainSha a
 * test seeds up front - so a result marker constructed for the second call
 * must match *that* recorded value, not the pre-integration feature commit.
 */
function latestIntegratedMainSha(item: AuthorityWorkItem): string {
  const marker = "<!-- pi-next-pending-verification -->\n";
  const matches = item.comments.filter((comment) => comment.body.startsWith(marker));
  const last = matches.at(-1);
  if (!last) throw new Error("no pending-verification marker found");
  return (JSON.parse(last.body.slice(marker.length)) as { integratedMainSha: string }).integratedMainSha;
}

function workItem(issueNumber: number, overrides: Partial<AuthorityWorkItem> = {}): AuthorityWorkItem {
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: "feat(finalize): add helper",
    body: "",
    state: "open",
    updatedAt: "2026-08-19T00:00:00Z",
    states: [],
    comments: [],
    ...overrides,
  };
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof BootstrapFinalizeError && error.code === code);
}

test("bootstrap finalizer commits, pushes directly to main, proves reachability, closes and cleans up", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101);
    const authority = new InMemoryWorkAuthority([workItem(101)]);
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "finalized");
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.localBranchRemoved, true);
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-101"));
    assert.match(await git(f.remote, "log", "--oneline", "main"), /feat\(finalize\): add helper \(#101\)/);
    assert.equal((await authority.get("101")).state, "closed");
    assert.ok(lines.some((line) => line.endsWith("PASS")));
  } finally { await f.cleanup(); }
});

test("finalizer accepts a verified file inside a newly untracked directory", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1411);
    await mkdir(join(worktree, "docs", "evaluation"), { recursive: true });
    await writeFile(join(worktree, "docs", "evaluation", "one.json"), "{}\n");
    const authority = new InMemoryWorkAuthority([workItem(1411)]);
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
    const authority = new InMemoryWorkAuthority([workItem(1412)]);
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
    const authority = new InMemoryWorkAuthority([workItem(1413)]);
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
    const authority = new InMemoryWorkAuthority([workItem(1414)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1414, authority, candidatePaths: ["candidate.txt"] }), "UNKNOWN_CHANGES");
    assert.equal((await authority.get("1414")).state, "open");
  } finally { await f.cleanup(); }
});

test("finalizer rejects an unrelated tracked modification outside verified candidate paths", async () => {
  const f = await fixture();
  try {
    const worktree = await cleanCandidate(f.root, 1415);
    await writeFile(join(worktree, "candidate.txt"), "candidate\n");
    await writeFile(join(worktree, "README.md"), "unrelated tracked\n");
    const authority = new InMemoryWorkAuthority([workItem(1415)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1415, authority, candidatePaths: ["candidate.txt"] }), "UNKNOWN_CHANGES");
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
    const authority = new InMemoryWorkAuthority([workItem(1416)]);
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
    const authority = new InMemoryWorkAuthority([workItem(1417)]);
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
    const authority = new InMemoryWorkAuthority([workItem(1418)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 1418, authority, candidatePaths: ["intended.txt"] }), "UNKNOWN_CHANGES");
    assert.equal(await git(worktree, "status", "--porcelain", "intended.txt"), "?? intended.txt");
  } finally { await f.cleanup(); }
});

test("finalizer refuses open zero-delta candidate without creating an empty commit", async () => {
  const f = await fixture();
  try {
    await cleanCandidate(f.root, 101);
    const authority = new InMemoryWorkAuthority([workItem(101)]);
    const before = await git(f.root, "rev-parse", "agent/issue-101");
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority }), "NO_CHANGE_CANDIDATE");
    assert.equal(await git(f.root, "rev-parse", "agent/issue-101"), before);
    assert.equal((await authority.get("101")).state, "open");
  } finally { await f.cleanup(); }
});

test("finalizer treats closed zero-delta candidate as harmless already-satisfied cleanup", async () => {
  const f = await fixture();
  try {
    await cleanCandidate(f.root, 101);
    const authority = new InMemoryWorkAuthority([workItem(101, { state: "closed" })]);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 101, authority });
    assert.equal(result.outcome, "already-satisfied");
    assert.equal(result.merged, false);
    assert.equal(result.issueClosed, true);
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-101"));
  } finally { await f.cleanup(); }
});

test("candidate already integrated by a prior crashed run resumes post-integration cleanup instead of zero-delta rejection", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 77);
    const authority = new InMemoryWorkAuthority([workItem(77)]);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 77, authority });
    assert.equal(result.outcome, "finalized");
    assert.equal(result.candidateSha, sha);
    assert.equal(result.issueClosed, true);
    assert.equal((await authority.get("77")).state, "closed");
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-77"));
  } finally { await f.cleanup(); }
});

test("candidate already integrated proves exact head reachability before cleanup", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 118);
    const authority = new InMemoryWorkAuthority([workItem(118)]);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 118, authority });
    assert.equal(result.reachable, true);
    assert.equal(await git(f.remote, "merge-base", "--is-ancestor", sha, "main").then(() => "yes"), "yes");
  } finally { await f.cleanup(); }
});

test("crash after reachability before authority reconciliation resumes without duplicate merge or premature close", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 201);
    const authority = new InMemoryWorkAuthority([workItem(201)]);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "authority_reconciled", position: "before" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 201, authority }),
      ),
      (error: unknown) => error instanceof LifecycleCheckpointFault
        && error.checkpoint === "authority_reconciled"
        && error.position === "before",
    );
    assert.equal((await authority.get("201")).state, "open");
    const candidateSha = await git(f.root, "rev-parse", "agent/issue-201");
    assert.equal(await git(f.remote, "merge-base", "--is-ancestor", candidateSha, "main").then(() => "yes"), "yes");
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-201")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 201, authority });
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal((await authority.get("201")).state, "closed");
  } finally { await f.cleanup(); }
});

test("crash after close before cleanup resumes without duplicate close", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 202);
    const authority = new InMemoryWorkAuthority([workItem(202)]);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "issue_closed", position: "after" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 202, authority }),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal((await authority.get("202")).state, "closed");
    assert.equal((await authority.get("202")).comments.length, 1);
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-202")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 202, authority });
    assert.equal(result.issueClosed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal((await authority.get("202")).comments.length, 1);
  } finally { await f.cleanup(); }
});

test("pending external verification crash before cleanup does not close or resurrect implementation", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 203);
    const authority = new InMemoryWorkAuthority([workItem(203, {
      comments: [{
        id: "pending",
        author: "operator",
        body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "deploy", environment: "staging" }], integratedMainSha: sha })}`,
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z",
      }],
    })]);
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "workspace_cleaned", position: "before" }, () =>
        runBootstrapFinalize({ cwd: f.root, issueNumber: 203, authority }),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal((await authority.get("203")).state, "open");
    assert.ok(await git(f.root, "worktree", "list", "--porcelain").then((text) => text.includes("issue-203")));

    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 203, authority });
    assert.equal(result.outcome, "integrated-pending-verification");
    assert.equal(result.issueClosed, false);
    assert.equal(result.worktreeRemoved, true);
    assert.equal((await authority.get("203")).state, "open");
  } finally { await f.cleanup(); }
});

test("cleanup retry preserves unique dirty work after interruption", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 204);
    const authority = new InMemoryWorkAuthority([workItem(204)]);
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
    assert.equal((await authority.get("204")).state, "closed");
  } finally { await f.cleanup(); }
});

test("finalizer fast-forwards a clean stale local main after reachability and cleanup", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedRemoteOnly(f.root, f.remote, 133);
    const authority = new InMemoryWorkAuthority([workItem(133)]);
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
    // finalizeIssue() fast-forwards root's local main internally as part of
    // its own merge sequence, via its own git invocation (not the injected
    // CommandRunner, so it never appears in `commands`) - by the time
    // synchronizeLocalMain() runs afterward it may find main already
    // current rather than performing a second fast-forward of its own.
    // Either is a correct, lossless outcome; what must never happen is a
    // destructive rebase/reset.
    assert.equal(commands.some((command) => /\srebase\s/.test(command)), false);
    assert.equal(commands.some((command) => /\sreset\s/.test(command)), false);
    assert.ok(["fast-forwarded", "already-current"].includes(result.localMainSync?.status ?? ""));
    assert.equal(await git(f.root, "rev-parse", "main"), sha);
    assert.equal(await git(f.root, "rev-parse", "origin/main"), sha);
    assert.ok(lines.indexOf("bootstrap finalize #133 · reachable from origin/main") < lines.indexOf("bootstrap finalize #133 · worktree removed"));
  } finally { await f.cleanup(); }
});

test("finalizer local-main sync is idempotent when main is already current", async () => {
  const f = await fixture();
  try {
    const { mergeSha } = await directlyIntegratedCandidate(f.root, f.remote, 134);
    const authority = new InMemoryWorkAuthority([workItem(134)]);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 134, authority });
    assert.equal(result.localMainSync?.status, "already-current");
    assert.equal(await git(f.root, "rev-parse", "main"), mergeSha);
  } finally { await f.cleanup(); }
});

// The old PR-based finalizer's "already merged" fast path never touched
// root's checkout at all, so it could tolerate a dirty/diverged/other-branch
// coordination root as long as nothing needed merging. finalizeIssue() (the
// #146 canonical finalizer) enforces root-on-main/clean/not-diverged as a
// blanket safety invariant for the merge/push mutation it may need to
// perform, even when this specific candidate turns out to need no new
// merge. The trade-off is deliberate: one simpler, more conservative
// finalizer instead of two. These three tests now verify the refusal is
// safe (no data loss, no destructive git operation) rather than that root's
// inconvenient state is silently tolerated.

test("dirty root checkout refuses finalize without losing or touching local work", async () => {
  const f = await fixture();
  try {
    await directlyIntegratedRemoteOnly(f.root, f.remote, 135);
    await writeFile(join(f.root, "README.md"), "local dirty work\n");
    const authority = new InMemoryWorkAuthority([workItem(135)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 135, authority }), "ROOT_DIRTY");
    assert.equal(await git(f.root, "status", "--porcelain"), "M README.md");
    assert.match(await git(f.root, "diff", "--", "README.md"), /local dirty work/);
  } finally { await f.cleanup(); }
});

test("diverged or ahead local main refuses finalize without resetting, rebasing, or merging it", async () => {
  const f = await fixture();
  try {
    await directlyIntegratedRemoteOnly(f.root, f.remote, 136);
    await writeFile(join(f.root, "local.txt"), "unique local main\n");
    await git(f.root, "add", "local.txt");
    await git(f.root, "commit", "-qm", "unique local main");
    const localMain = await git(f.root, "rev-parse", "main");
    const authority = new InMemoryWorkAuthority([workItem(136)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 136, authority }), "UNSAFE_ROOT");
    assert.equal(await git(f.root, "rev-parse", "main"), localMain);
  } finally { await f.cleanup(); }
});

test("root checkout on another branch refuses finalize without switching it", async () => {
  const f = await fixture();
  try {
    await directlyIntegratedRemoteOnly(f.root, f.remote, 137);
    await git(f.root, "switch", "-c", "operator-topic");
    const authority = new InMemoryWorkAuthority([workItem(137)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 137, authority }), "UNSAFE_ROOT");
    assert.equal(await git(f.root, "branch", "--show-current"), "operator-topic");
  } finally { await f.cleanup(); }
});

test("prose mentioning pending external verification does not block exact-candidate recovery", async () => {
  const f = await fixture();
  try {
    await directlyIntegratedCandidate(f.root, f.remote, 119);
    const authority = new InMemoryWorkAuthority([workItem(119, {
      body: [
        "honor pending external verification and changed-authority rules",
        "",
        "pending external verification remains open and cleanup behavior follows repository lifecycle policy",
      ].join("\n"),
    })]);
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 119, authority });
    assert.equal(result.issueClosed, true);
    assert.equal((await authority.get("119")).state, "closed");
  } finally { await f.cleanup(); }
});

test("explicit structured pending external verification marker leaves integrated issue open but cleans worktree", async () => {
  const f = await fixture();
  try {
    const { sha, worktree } = await directlyIntegratedCandidate(f.root, f.remote, 122);
    const authority = new InMemoryWorkAuthority([workItem(122, {
      comments: [{
        id: "pending",
        author: "operator",
        body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "verify deployed revision", environment: "production" }], integratedMainSha: sha })}`,
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z",
      }],
    })]);
    const lines: string[] = [];
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 122, authority, reporter: (line) => lines.push(line) });
    assert.equal(result.outcome, "integrated-pending-verification");
    assert.equal(result.issueClosed, false);
    assert.equal(result.pendingExternalVerification, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.localBranchRemoved, true);
    assert.equal((await authority.get("122")).state, "open");
    await assert.rejects(git(worktree, "status", "--porcelain"));
    await assert.rejects(git(f.root, "rev-parse", "--verify", "agent/issue-122"));
    assert.ok(lines.includes("bootstrap finalize #122 · external verification pending · issue remains open"));
    assert.ok(lines.includes("bootstrap finalize #122 · INTEGRATED_PENDING_VERIFICATION"));
  } finally { await f.cleanup(); }
});

test("pending integrated finalization rerun is idempotent after worktree and branch cleanup", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 123);
    const authority = new InMemoryWorkAuthority([workItem(123, {
      comments: [{
        id: "pending",
        author: "operator",
        body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "verify deployed revision", environment: "production" }], integratedMainSha: sha })}`,
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z",
      }],
    })]);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 123, authority });
    const rerun = await runBootstrapFinalize({ cwd: f.root, issueNumber: 123, authority });
    assert.equal(rerun.outcome, "integrated-pending-verification");
    assert.equal(rerun.worktreeRemoved, true);
    assert.equal(rerun.localBranchRemoved, true);
    assert.equal((await authority.get("123")).state, "open");
  } finally { await f.cleanup(); }
});

test("successful external verification result closes without recreating old worktree", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 125);
    const pendingComment = { id: "pending", author: "operator", body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "verify", environment: "production" }], integratedMainSha: sha })}`, createdAt: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T00:00:00Z" };
    const authority = new InMemoryWorkAuthority([workItem(125, { comments: [pendingComment] })]);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 125, authority });
    const integratedMainSha = latestIntegratedMainSha(await authority.get("125"));
    const resultComment = { id: "pass", author: "operator", body: `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha, status: "passed", evidence: "operator approved" })}`, createdAt: "2026-08-19T00:01:00Z", updatedAt: "2026-08-19T00:01:00Z" };
    authority.upsert({ ...(await authority.get("125")), comments: [pendingComment, resultComment] });
    const result = await runBootstrapFinalize({ cwd: f.root, issueNumber: 125, authority });
    assert.equal(result.outcome, "finalized");
    assert.equal(result.issueClosed, true);
    assert.equal((await authority.get("125")).state, "closed");
  } finally { await f.cleanup(); }
});

test("failed external verification does not close and allows a fresh branch from current main", async () => {
  const f = await fixture();
  try {
    const { sha } = await directlyIntegratedCandidate(f.root, f.remote, 126);
    const pendingComment = { id: "pending", author: "operator", body: `<!-- pi-next-pending-verification -->\n${JSON.stringify({ version: 1, status: "awaiting_external_verification", criteria: [{ id: "deploy", description: "verify", environment: "production" }], integratedMainSha: sha })}`, createdAt: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T00:00:00Z" };
    const authority = new InMemoryWorkAuthority([workItem(126, { comments: [pendingComment] })]);
    await runBootstrapFinalize({ cwd: f.root, issueNumber: 126, authority });
    const integratedMainSha = latestIntegratedMainSha(await authority.get("126"));
    const resultComment = { id: "fail", author: "operator", body: `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha, status: "failed", evidence: "operator evidence" })}`, createdAt: "2026-08-19T00:01:00Z", updatedAt: "2026-08-19T00:01:00Z" };
    authority.upsert({ ...(await authority.get("126")), comments: [pendingComment, resultComment] });
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 126, authority }), "EXTERNAL_VERIFICATION_FAILED");
    assert.equal((await authority.get("126")).state, "open");
    const fresh = await cleanCandidate(f.root, 126);
    assert.equal(await git(fresh, "rev-parse", "HEAD"), await git(f.root, "rev-parse", "origin/main"));
  } finally { await f.cleanup(); }
});

test("dirty unique work appearing after direct integration blocks cleanup", async () => {
  const f = await fixture();
  try {
    const { worktree } = await directlyIntegratedCandidate(f.root, f.remote, 119);
    await writeFile(join(worktree, "unique.txt"), "do not delete\n");
    const authority = new InMemoryWorkAuthority([workItem(119)]);
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, issueNumber: 119, authority }), "UNIQUE_WORK_PRESENT");
    assert.equal(await git(worktree, "status", "--porcelain"), "?? unique.txt");
  } finally { await f.cleanup(); }
});

test("explicit --issue selects one candidate when another candidate exists", async () => {
  const f = await fixture();
  try {
    await dirtyCandidate(f.root, 101, "a.txt");
    await dirtyCandidate(f.root, 102, "b.txt");
    const authority = new InMemoryWorkAuthority([workItem(102)]);
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
    await rejectsCode(runBootstrapFinalize({ cwd: f.root, authority: new InMemoryWorkAuthority([workItem(101)]) }), "AMBIGUOUS_CANDIDATE");
  } finally { await f.cleanup(); }
});

test("first unstaged tracked candidate path preserves porcelain status columns", async () => {
  const f = await fixture();
  try {
    await dirtyTrackedCandidate(f.root, 101);
    const authority = new InMemoryWorkAuthority([workItem(101)]);
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
    const authority = new InMemoryWorkAuthority([workItem(101)]);
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

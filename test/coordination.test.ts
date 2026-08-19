import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  claimIssueLease,
  createIssueLease,
  ensureIssueWorktree,
  isIssueLeaseFresh,
  issueWorkspaceIdentity,
  parseIssueLease,
  serializeIssueLease,
  LeaseConflictError,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";

const exec = promisify(execFile);

class MemoryAuthority implements IssueLeaseAuthority {
  private readonly leases = new Map<number, IssueLease>();

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    return this.leases.get(issueNumber);
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    if (this.leases.has(issueNumber)) throw new Error("already exists");
    this.leases.set(issueNumber, lease);
  }

  async replace(issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    if (this.leases.get(issueNumber) !== expected) throw new Error("compare-and-swap failed");
    this.leases.set(issueNumber, lease);
  }

  async remove(issueNumber: number, expected: IssueLease): Promise<void> {
    if (this.leases.get(issueNumber) !== expected) throw new Error("compare-and-swap failed");
    this.leases.delete(issueNumber);
  }
}

function lease(runId: string, now = new Date()): IssueLease {
  return createIssueLease({
    issueNumber: 7,
    agent: "pi-next",
    runId,
    sessionId: `session-${runId}`,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

/** Every mutating Git fixture must prove it is isolated from real remotes. */
async function assertFixtureRemote(cwd: string, fixtureRoot: string): Promise<void> {
  const remote = await git(cwd, "remote", "get-url", "origin");
  assert.ok(remote.startsWith(fixtureRoot), `fixture remote escaped temporary root: ${remote}`);
  assert.doesNotMatch(remote, /github\.com|gitlab\.com|bitbucket\.org/i);
}

test("issue identity and lease serialization preserve derived ownership", () => {
  const identity = issueWorkspaceIdentity(7);
  assert.deepEqual(identity, {
    issueNumber: 7,
    branch: "agent/issue-7",
    worktree: ".worktrees/issue-7",
  });
  const value = lease("run-1");
  assert.equal(isIssueLeaseFresh(value), true);
  assert.equal(value.branch, identity.branch);
  assert.equal(value.worktree, identity.worktree);
  assert.deepEqual(parseIssueLease(serializeIssueLease(value)), value);
});

test("concurrent claims have one authoritative owner", async () => {
  const authority = new MemoryAuthority();
  const now = new Date();
  const input = (runId: string) => ({
    issueNumber: 7,
    agent: "pi-next" as const,
    runId,
    sessionId: `session-${runId}`,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  const results = await Promise.allSettled([
    claimIssueLease(authority, input("run-a"), now),
    claimIssueLease(authority, input("run-b"), now),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof LeaseConflictError);
});

test("canonical worktrees are created from a temporary bare remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-test-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  try {
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "--initial-branch=main", repo]);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "pi-next test");
    await writeFile(join(repo, "README.md"), "fixture\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "fixture");
    await git(repo, "remote", "add", "origin", remote);
    await assertFixtureRemote(repo, root);
    await git(repo, "push", "origin", "main");

    const worktree = await ensureIssueWorktree(repo, 7);
    assert.equal(worktree, join(repo, ".worktrees", "issue-7"));
    assert.equal(await git(worktree, "branch", "--show-current"), "agent/issue-7");
    await assertFixtureRemote(repo, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

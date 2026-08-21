import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  checkpointBranchName,
  checkpointCommit,
} from "../extensions/pi-next/checkpoint.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-checkpoint-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const workspace = join(repo, ".worktrees", "issue-638");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "pi-next test");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await writeFile(join(repo, ".gitignore"), ".worktrees/\n");
  await git(repo, "add", "README.md", ".gitignore");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  await git(repo, "branch", "agent/issue-638");
  await git(repo, "worktree", "add", "--quiet", workspace, "agent/issue-638");
  return { root, repo, workspace };
}

test("checkpoint branch identity is the canonical agent/issue-N branch", () => {
  assert.equal(checkpointBranchName(638, "run-1"), "agent/issue-638");
  assert.equal(checkpointBranchName(638, "a different run"), "agent/issue-638");
  assert.throws(() => checkpointBranchName(638, "   "), /branch-safe identifier/);
});

test("checkpoint commits on the canonical branch and pushes that identity", async () => {
  const state = await fixture();
  try {
    await writeFile(join(state.workspace, "checkpoint.txt"), "checkpoint\n");
    const result = await checkpointCommit(
      state.workspace,
      638,
      "run-638",
      ["checkpoint.txt"],
      "chore(agent): checkpoint issue progress",
    );
    assert.equal(result.branch, "agent/issue-638");
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.match(await git(state.repo, "ls-remote", "--heads", "origin", "agent/issue-638"), /agent\/issue-638/);
    assert.equal(await git(state.repo, "ls-remote", "--heads", "origin", "pi-next/issue-638/run-638"), "");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("checkpoint restart stays on the canonical branch and stages only explicit paths", async () => {
  const state = await fixture();
  try {
    await writeFile(join(state.workspace, "first.txt"), "first\n");
    await checkpointCommit(state.workspace, 638, "first-run", ["first.txt"], "checkpoint: first");
    await writeFile(join(state.workspace, "second.txt"), "second\n");
    await writeFile(join(state.workspace, "not-checkpointed.txt"), "preserve\n");
    const result = await checkpointCommit(state.workspace, 638, "resumed-run", ["second.txt"], "checkpoint: resumed");
    assert.equal(result.branch, "agent/issue-638");
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.equal(await readFile(join(state.workspace, "not-checkpointed.txt"), "utf8"), "preserve\n");
    assert.equal(await git(state.workspace, "show", "HEAD:not-checkpointed.txt").catch(() => ""), "");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("checkpoint rejects foreign branches without switching them", async () => {
  const state = await fixture();
  try {
    await git(state.workspace, "switch", "-c", "agent/issue-999");
    await writeFile(join(state.workspace, "foreign.txt"), "foreign\n");
    await assert.rejects(
      () => checkpointCommit(state.workspace, 638, "run-638", ["foreign.txt"], "checkpoint: foreign"),
      /Refusing to switch from unrelated branch agent\/issue-999/,
    );
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-999");
    assert.equal(await git(state.workspace, "status", "--porcelain"), "?? foreign.txt");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("checkpoint never mutates coordination main", async () => {
  const state = await fixture();
  try {
    await writeFile(join(state.repo, "coordination-change.txt"), "must remain on main\n");
    await assert.rejects(
      () => checkpointCommit(state.repo, 638, "run-638", ["coordination-change.txt"], "checkpoint: unsafe root"),
    );
    assert.equal(await git(state.repo, "branch", "--show-current"), "main");
    assert.equal(await git(state.repo, "status", "--porcelain"), "?? coordination-change.txt");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

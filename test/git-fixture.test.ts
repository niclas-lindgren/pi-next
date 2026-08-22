import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import { createDisposableGitFixture } from "./helpers/git-fixture.ts";

test("disposable Git fixture creates deterministic main and local bare origin", async () => {
  const fixture = await createDisposableGitFixture({ prefix: "pi-next-scenario-fixture-" });
  try {
    assert.equal(await fixture.git(fixture.repo, "branch", "--show-current"), "main");
    assert.equal(await fixture.git(fixture.repo, "status", "--porcelain"), "");
    assert.ok(fixture.origin);
    assert.equal(await fixture.git(fixture.repo, "remote", "get-url", "origin"), fixture.origin);
    assert.match(await fixture.git(fixture.repo, "ls-remote", "--heads", "origin", "main"), /refs\/heads\/main/);
    assert.equal(await fixture.revision(), await fixture.revision(fixture.repo, "origin/main"));
  } finally {
    await fixture.cleanup();
  }
});

test("disposable Git fixture creates canonical issue branch and worktree", async () => {
  const fixture = await createDisposableGitFixture();
  try {
    const worktree = await fixture.addIssueWorktree(76);
    assert.equal(worktree.branch, "agent/issue-76");
    assert.equal(await fixture.git(worktree.path, "branch", "--show-current"), "agent/issue-76");
    assert.equal(await fixture.revision(worktree.path), await fixture.revision(fixture.repo, "main"));
  } finally {
    await fixture.cleanup();
  }
});

test("disposable Git fixture cleanup is complete and idempotent", async () => {
  const fixture = await createDisposableGitFixture();
  const root = fixture.root;
  await fixture.cleanup();
  await fixture.cleanup();
  await assert.rejects(access(root));
});

test("disposable Git fixture exposes no hosted-remote configuration surface", async () => {
  const fixture = await createDisposableGitFixture({ withOrigin: false });
  try {
    assert.equal(fixture.origin, undefined);
    assert.equal(await fixture.git(fixture.repo, "remote"), "");
  } finally {
    await fixture.cleanup();
  }
});

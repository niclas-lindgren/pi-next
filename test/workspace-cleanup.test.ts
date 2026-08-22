import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  cleanupCompletedIssueWorktree,
  IssueWorkspaceCleanupError,
} from "../extensions/pi-next/main-refresh.ts";
import { createDisposableGitFixture, type DisposableGitFixture } from "./helpers/git-fixture.ts";

const fixtures: DisposableGitFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup();
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function newFixture(prefix: string): Promise<DisposableGitFixture> {
  const fixture = await createDisposableGitFixture({
    prefix,
    userName: "Cleanup Test",
    userEmail: "cleanup@example.invalid",
    initialFiles: { "README.md": "baseline\n" },
  });
  fixtures.push(fixture);
  return fixture;
}

async function setupRepo(issueNumber: number): Promise<{ fixture: DisposableGitFixture; root: string; workspace: string }> {
  const fixture = await newFixture("workspace-cleanup-");
  const root = fixture.repo;
  const branch = `agent/issue-${issueNumber}`;

  git(root, ["switch", "-c", branch]);
  writeFileSync(join(root, "integrated.txt"), "integrated\n");
  git(root, ["add", "integrated.txt"]);
  git(root, ["commit", "-qm", `feat: issue #${issueNumber}`]);
  git(root, ["switch", "main"]);
  git(root, ["merge", "--ff-only", branch]);
  git(root, ["push", "-q", "origin", "main"]);

  const { path: workspace } = await fixture.addIssueWorktree(issueNumber);
  return { fixture, root, workspace };
}

describe("cleanupCompletedIssueWorktree", () => {
  test("removes the closed issue worktree and local branch after integration", async () => {
    const issueNumber = 701;
    const { root, workspace } = await setupRepo(issueNumber);

    await cleanupCompletedIssueWorktree(root, workspace, issueNumber);

    assert.equal(git(root, ["worktree", "list", "--porcelain"]).includes(workspace), false);
    assert.equal(git(root, ["branch", "--list", `agent/issue-${issueNumber}`]), "");
    assert.match(git(root, ["branch", "-r"]), new RegExp(`origin/main`));
  });

  test("also removes an open-awaiting-verification workspace after the same integration proof", async () => {
    const issueNumber = 702;
    const { root, workspace } = await setupRepo(issueNumber);

    // Cleanup is intentionally authority-neutral: the caller may have left the
    // issue open with a durable pending-verification record.
    await cleanupCompletedIssueWorktree(root, workspace, issueNumber);

    assert.equal(git(root, ["branch", "--list", `agent/issue-${issueNumber}`]), "");
  });

  test("allows only the generated verification-artifact cleanup commit after integration", async () => {
    const issueNumber = 703;
    const { root, workspace } = await setupRepo(issueNumber);
    const verify = join(root, ".ps-next", "VERIFY.md");
    mkdirSync(join(root, ".ps-next"), { recursive: true });
    writeFileSync(verify, "pending evidence\n");
    git(root, ["add", verify]);
    git(root, ["commit", "-qm", "record pending verification"]);
    git(root, ["push", "-q", "origin", "main"]);
    git(workspace, ["merge", "--ff-only", "main"]);
    rmSync(join(workspace, ".ps-next", "VERIFY.md"));
    git(workspace, ["add", "-u", ".ps-next/VERIFY.md"]);
    git(workspace, ["commit", "-qm", "chore(agent): remove completed issue #703 verification artifact"]);

    await cleanupCompletedIssueWorktree(root, workspace, issueNumber);

    assert.equal(git(root, ["branch", "--list", `agent/issue-${issueNumber}`]), "");
  });

  test("preserves an unintegrated branch instead of deleting unique work", async () => {
    const issueNumber = 704;
    const fixture = await newFixture("workspace-cleanup-");
    const root = fixture.repo;
    const branch = `agent/issue-${issueNumber}`;
    git(root, ["switch", "-c", branch]);
    writeFileSync(join(root, "unique.txt"), "not integrated\n");
    git(root, ["add", "unique.txt"]);
    git(root, ["commit", "-qm", "feat: unique work"]);
    git(root, ["switch", "main"]);
    const { path: workspace } = await fixture.addIssueWorktree(issueNumber);

    await assert.rejects(
      cleanupCompletedIssueWorktree(root, workspace, issueNumber),
      (error: unknown) => error instanceof IssueWorkspaceCleanupError && /not reachable/.test(error.message),
    );
    assert.equal(
      git(root, ["branch", "--list", `agent/issue-${issueNumber}`]).replace(/^\+\s*/, ""),
      `agent/issue-${issueNumber}`,
    );
    assert.equal(git(root, ["worktree", "list", "--porcelain"]).includes(workspace), true);
  });
});

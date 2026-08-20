import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  cleanupCompletedIssueWorktree,
  IssueWorkspaceCleanupError,
} from "../extensions/pi-next/main-refresh.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function mktemp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupRepo(issueNumber: number): { root: string; workspace: string } {
  const origin = mktemp("workspace-cleanup-origin-");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  const root = mktemp("workspace-cleanup-root-");
  execFileSync("git", ["clone", "-q", origin, root]);
  git(root, ["config", "user.name", "Cleanup Test"]);
  git(root, ["config", "user.email", "cleanup@example.invalid"]);
  writeFileSync(join(root, "README.md"), "baseline\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "baseline"]);
  git(root, ["branch", "-M", "main"]);
  git(root, ["push", "-q", "-u", "origin", "main"]);

  git(root, ["switch", "-c", `agent/issue-${issueNumber}`]);
  writeFileSync(join(root, "integrated.txt"), "integrated\n");
  git(root, ["add", "integrated.txt"]);
  git(root, ["commit", "-qm", `feat: issue #${issueNumber}`]);
  git(root, ["switch", "main"]);
  git(root, ["merge", "--ff-only", `agent/issue-${issueNumber}`]);
  git(root, ["push", "-q", "origin", "main"]);

  const workspace = join(root, ".worktrees", `issue-${issueNumber}`);
  mkdirSync(join(root, ".worktrees"), { recursive: true });
  git(root, ["worktree", "add", "-q", workspace, `agent/issue-${issueNumber}`]);
  return { root, workspace };
}

describe("cleanupCompletedIssueWorktree", () => {
  test("removes the closed issue worktree and local branch after integration", async () => {
    const issueNumber = 701;
    const { root, workspace } = setupRepo(issueNumber);

    await cleanupCompletedIssueWorktree(root, workspace, issueNumber);

    assert.equal(git(root, ["worktree", "list", "--porcelain"]).includes(workspace), false);
    assert.equal(git(root, ["branch", "--list", `agent/issue-${issueNumber}`]), "");
    assert.match(git(root, ["branch", "-r"]), new RegExp(`origin/main`));
  });

  test("also removes an open-awaiting-verification workspace after the same integration proof", async () => {
    const issueNumber = 702;
    const { root, workspace } = setupRepo(issueNumber);

    // Cleanup is intentionally authority-neutral: the caller may have left the
    // issue open with a durable pending-verification record.
    await cleanupCompletedIssueWorktree(root, workspace, issueNumber);

    assert.equal(git(root, ["branch", "--list", `agent/issue-${issueNumber}`]), "");
  });

  test("allows only the generated verification-artifact cleanup commit after integration", async () => {
    const issueNumber = 703;
    const { root, workspace } = setupRepo(issueNumber);
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
    const origin = mktemp("workspace-cleanup-origin-");
    execFileSync("git", ["init", "--bare", "-q", origin]);
    const root = mktemp("workspace-cleanup-root-");
    execFileSync("git", ["clone", "-q", origin, root]);
    git(root, ["config", "user.name", "Cleanup Test"]);
    git(root, ["config", "user.email", "cleanup@example.invalid"]);
    writeFileSync(join(root, "README.md"), "baseline\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "baseline"]);
    git(root, ["branch", "-M", "main"]);
    git(root, ["push", "-q", "-u", "origin", "main"]);
    git(root, ["switch", "-c", `agent/issue-${issueNumber}`]);
    writeFileSync(join(root, "unique.txt"), "not integrated\n");
    git(root, ["add", "unique.txt"]);
    git(root, ["commit", "-qm", "feat: unique work"]);
    git(root, ["switch", "main"]);
    const workspace = join(root, ".worktrees", `issue-${issueNumber}`);
    mkdirSync(join(root, ".worktrees"), { recursive: true });
    git(root, ["worktree", "add", "-q", workspace, `agent/issue-${issueNumber}`]);

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

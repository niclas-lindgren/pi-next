import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface DisposableGitFixtureOptions {
  prefix?: string;
  withOrigin?: boolean;
  initialFiles?: Record<string, string>;
  userName?: string;
  userEmail?: string;
}

export interface IssueWorktree {
  branch: string;
  path: string;
}

export interface DisposableGitFixture {
  root: string;
  repo: string;
  origin?: string;
  git(cwd: string, ...args: string[]): Promise<string>;
  write(cwd: string, path: string, content: string): Promise<void>;
  commit(cwd: string, message: string, paths?: string[]): Promise<string>;
  revision(cwd?: string, ref?: string): Promise<string>;
  addIssueWorktree(issueNumber: number): Promise<IssueWorktree>;
  cleanup(): Promise<void>;
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`issueNumber must be a positive integer, got ${issueNumber}`);
  }
}

export async function createDisposableGitFixture(
  options: DisposableGitFixtureOptions = {},
): Promise<DisposableGitFixture> {
  const root = await mkdtemp(join(tmpdir(), options.prefix ?? "pi-next-git-fixture-"));
  const repo = join(root, "repo");
  const withOrigin = options.withOrigin ?? true;
  const origin = withOrigin ? join(root, "origin.git") : undefined;
  let cleaned = false;

  try {
    if (origin) await exec("git", ["init", "--bare", "--quiet", origin]);
    await exec("git", ["init", "--quiet", "--initial-branch=main", repo]);
    await runGit(repo, "config", "user.name", options.userName ?? "pi-next test");
    await runGit(repo, "config", "user.email", options.userEmail ?? "test@example.invalid");

    const initialFiles = options.initialFiles ?? { "README.md": "fixture\n" };
    const paths = Object.keys(initialFiles);
    if (paths.length === 0) throw new Error("disposable Git fixture requires at least one initial file");
    for (const [path, content] of Object.entries(initialFiles)) {
      const target = resolve(repo, path);
      if (target !== repo && !target.startsWith(`${repo}/`)) throw new Error(`fixture path escapes repository: ${path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await runGit(repo, "add", "--", ...paths);
    await runGit(repo, "commit", "--quiet", "-m", "fixture baseline");

    if (origin) {
      await runGit(repo, "remote", "add", "origin", origin);
      await runGit(repo, "push", "--quiet", "-u", "origin", "main");
    }

    const fixture: DisposableGitFixture = {
      root,
      repo,
      origin,
      git: runGit,
      async write(cwd, path, content) {
        const base = resolve(cwd);
        const target = resolve(base, path);
        if (target !== base && !target.startsWith(`${base}/`)) throw new Error(`fixture path escapes working tree: ${path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      },
      async commit(cwd, message, paths) {
        if (paths?.length) await runGit(cwd, "add", "--", ...paths);
        else await runGit(cwd, "add", "-A");
        await runGit(cwd, "commit", "--quiet", "-m", message);
        return runGit(cwd, "rev-parse", "HEAD");
      },
      revision(cwd = repo, ref = "HEAD") {
        return runGit(cwd, "rev-parse", ref);
      },
      async addIssueWorktree(issueNumber) {
        assertIssueNumber(issueNumber);
        const branch = `agent/issue-${issueNumber}`;
        const path = join(repo, ".worktrees", `issue-${issueNumber}`);
        await mkdir(join(repo, ".worktrees"), { recursive: true });
        const existing = await runGit(repo, "branch", "--list", branch);
        if (!existing) await runGit(repo, "branch", branch, "main");
        await runGit(repo, "worktree", "add", "--quiet", path, branch);
        return { branch, path };
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(root, { recursive: true, force: true });
      },
    };

    return fixture;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

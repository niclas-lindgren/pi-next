import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function expectSafetyFailure(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const value = error as { stderr?: string; message?: string };
    const text = `${value.stderr ?? ""}\n${value.message ?? ""}`;
    assert.match(text, pattern);
    return true;
  });
}

test("suite-wide Git guard refuses mutation of the real source checkout", async () => {
  assert.ok(process.env.PI_NEXT_TEST_SOURCE_ROOT, "safe Git test runner must install the guard");
  const root = process.env.PI_NEXT_TEST_SOURCE_ROOT!;
  const before = await git(root, "rev-parse", "HEAD");

  await expectSafetyFailure(
    exec("git", ["-C", root, "commit", "--allow-empty", "-m", "must never reach source checkout"]),
    /refusing commit repository in the real source checkout/i,
  );

  assert.equal(await git(root, "rev-parse", "HEAD"), before);
});

test("suite-wide Git guard rejects a hosted push before any network operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-git-safety-hosted-"));
  try {
    await exec("git", ["init", "--initial-branch=main", root]);
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "pi-next test");
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "fixture");

    await expectSafetyFailure(
      exec("git", ["-C", root, "push", "https://github.com/example/never.git", "HEAD:main"]),
      /refusing push to non-fixture remote/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("suite-wide Git guard permits mutation and push inside a disposable bare-origin fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-git-safety-local-"));
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  try {
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "--initial-branch=main", repo]);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "pi-next test");
    await writeFile(join(repo, "README.md"), "fixture\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "fixture");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "origin", "main");

    assert.match(await git(repo, "ls-remote", "--heads", "origin", "main"), /refs\/heads\/main/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

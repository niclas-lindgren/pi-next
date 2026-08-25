import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { forbiddenWorkerCommand } from "../src/coordination/forbidden-worker-command.ts";
import { workerShellCommandDecision } from "../src/coordination/worker-shell-policy.ts";
import { registerSafeBashTool } from "../extensions/pi-next/tools-safe-bash.ts";

const exec = promisify(execFile);

type SafeBashExecute = (
  id: string,
  params: { command: string },
  signal: AbortSignal | undefined,
  update: () => void,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ type: "text"; text: string }>; details: { refused?: boolean; exitCode?: number | null } }>;

function captureSafeBashTool(): SafeBashExecute | undefined {
  let execute: SafeBashExecute | undefined;
  registerSafeBashTool({
    registerTool(tool: { name: string; execute: SafeBashExecute }) {
      if (tool.name === "safe_bash") execute = tool.execute;
    },
  } as never);
  return execute;
}

test("forbiddenWorkerCommand refuses production worker merge/close/push/gh-issue commands", () => {
  for (const command of [
    "git push origin main",
    "git merge feature",
    "git checkout main",
    "git branch -D feature",
    "gh issue close 162",
    "gh pr merge 162",
    "sudo git push origin main",
    "env git push origin main",
    "/usr/bin/git push origin main",
    "sh -c 'git push origin main'",
    "node -e \"require('child_process').execSync('git push origin main')\"",
    "python -c \"import subprocess; subprocess.run(['git','push','origin','main'])\"",
    "echo hi; git push origin main",
    "rm -rf .git",
  ]) {
    assert.equal(forbiddenWorkerCommand(command), true, command);
    assert.equal(workerShellCommandDecision(command).allowed, false, command);
  }
  for (const command of ["npm test", "npm run typecheck", "git status", "git diff", "echo hello"]) {
    assert.equal(forbiddenWorkerCommand(command), false, command);
    assert.equal(workerShellCommandDecision(command).allowed, true, command);
  }
});

test("production safe_bash tool is registered only for isolated issue workers and refuses authority-bypass commands", async () => {
  const priorWorkerFlag = process.env.PI_NEXT_ISSUE_WORKER;
  try {
    delete process.env.PI_NEXT_ISSUE_WORKER;
    assert.equal(captureSafeBashTool(), undefined);

    process.env.PI_NEXT_ISSUE_WORKER = "1";
    const execute = captureSafeBashTool();
    assert.ok(execute);

    const refused = await execute("call-1", { command: "git push origin main" }, new AbortController().signal, () => {}, { cwd: process.cwd() });
    assert.equal(refused.details.refused, true);
    assert.match(refused.content[0].text, /Refused/);

    const allowed = await execute("call-2", { command: "echo issue-162" }, new AbortController().signal, () => {}, { cwd: process.cwd() });
    assert.equal(allowed.details.exitCode, 0);
    assert.match(allowed.content[0].text, /issue-162/);
  } finally {
    if (priorWorkerFlag === undefined) delete process.env.PI_NEXT_ISSUE_WORKER;
    else process.env.PI_NEXT_ISSUE_WORKER = priorWorkerFlag;
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-safe-bash-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["clone", remote, work]);
  await git(work, ["config", "user.email", "safe-bash@example.invalid"]);
  await git(work, ["config", "user.name", "safe bash"]);
  await writeFile(join(work, "README.md"), "baseline\n");
  await git(work, ["add", "README.md"]);
  await git(work, ["commit", "-qm", "baseline"]);
  await git(work, ["push", "origin", "HEAD:main"]);
  const baselineRemoteMain = await git(work, ["ls-remote", "origin", "refs/heads/main"]);
  await writeFile(join(work, "README.md"), "candidate\n");
  await git(work, ["commit", "-am", "candidate"]);
  return { root, remote, work, baselineRemoteMain, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("production safe_bash refuses wrapper/interpreter authority bypasses before protected git state changes", async () => {
  const priorWorkerFlag = process.env.PI_NEXT_ISSUE_WORKER;
  const f = await gitFixture();
  try {
    process.env.PI_NEXT_ISSUE_WORKER = "1";
    const execute = captureSafeBashTool();
    assert.ok(execute);
    const gitPath = (await exec("command", ["-v", "git"]).catch(async () => exec("which", ["git"]))).stdout.trim();
    const bypasses = [
      "env git push origin main",
      `${gitPath} push origin main`,
      "sh -c 'git push origin main'",
      "node -e \"require('child_process').execFileSync('git',['push','origin','main'])\"",
      "python -c \"import subprocess; subprocess.run(['gh','issue','close','162'])\"",
    ];

    for (const command of bypasses) {
      const result = await execute("bypass", { command }, new AbortController().signal, () => {}, { cwd: f.work });
      assert.equal(result.details.refused, true, command);
      assert.match(result.content[0].text, /Refused/, command);
      assert.equal(await git(f.work, ["ls-remote", "origin", "refs/heads/main"]), f.baselineRemoteMain, command);
    }
  } finally {
    if (priorWorkerFlag === undefined) delete process.env.PI_NEXT_ISSUE_WORKER;
    else process.env.PI_NEXT_ISSUE_WORKER = priorWorkerFlag;
    await f.cleanup();
  }
});

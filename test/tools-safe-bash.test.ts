import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { forbiddenWorkerCommand } from "../src/coordination/forbidden-worker-command.ts";
import { createWorkerShellExecution, workerShellCommandDecision } from "../src/coordination/worker-shell-policy.ts";
import { registerSafeBashTool } from "../extensions/pi-next/tools-safe-bash.ts";

const execFilePromise = promisify(execFile);
const exec: typeof execFilePromise = (async (file: string, args?: readonly string[], options?: Parameters<typeof execFilePromise>[2]) => execFilePromise(file, args ?? [], {
  ...options,
  env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", ...(options?.env ?? {}) },
})) as typeof execFilePromise;

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
  await git(work, ["branch", "-M", "main"]);
  await git(work, ["push", "origin", "main"]);
  const baselineRemoteMain = await git(work, ["ls-remote", "origin", "refs/heads/main"]);
  const baselineLocalMain = await git(work, ["rev-parse", "refs/heads/main"]);
  await git(work, ["checkout", "-qb", "agent/issue-162"]);
  await writeFile(join(work, "README.md"), "candidate\n");
  await git(work, ["commit", "-am", "candidate"]);
  return { root, remote, work, baselineRemoteMain, baselineLocalMain, cleanup: () => rm(root, { recursive: true, force: true }) };
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

test("release gate and worker shell bubblewrap smoke expose the x64 dynamic linker alias", async (t) => {
  const workflow = await readFile(join(process.cwd(), ".github/workflows/release-gate.yml"), "utf8");
  assert.match(workflow, /--symlink usr\/lib64 \/lib64/);

  if (process.platform !== "linux") return t.skip("bubblewrap OS sandbox is Linux-only");
  const root = await mkdtemp(join(tmpdir(), "pi-next-safe-bash-loader-"));
  try {
    const decision = workerShellCommandDecision("node --version");
    assert.equal(decision.allowed, true);
    const execution = createWorkerShellExecution(root, decision, { PATH: process.env.PATH ?? "" });
    try {
      if (!execution.args.includes("--unshare-all")) return t.skip("bubblewrap is unavailable");
      const hasLoaderAlias = execution.args.some((arg, index, args) => arg === "--symlink" && args[index + 1] === "usr/lib64" && args[index + 2] === "/lib64");
      assert.equal(hasLoaderAlias, true);
    } finally {
      execution.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production safe_bash runs repository-controlled launchers in a detached non-authoritative workspace", async (t) => {
  if (process.platform !== "linux") return t.skip("bubblewrap OS sandbox is Linux-only");
  const priorWorkerFlag = process.env.PI_NEXT_ISSUE_WORKER;
  const f = await gitFixture();
  try {
    process.env.PI_NEXT_ISSUE_WORKER = "1";
    const execute = captureSafeBashTool();
    assert.ok(execute);
    const protectedRef = join(f.work, ".git", "refs", "heads", "main");
    await writeFile(join(f.work, "bypass.js"), "require('node:child_process').execFileSync('git', ['update-ref', 'refs/heads/main', 'HEAD'], {stdio: 'inherit'});\n");
    await writeFile(join(f.work, "fs-bypass.js"), `require('node:fs').writeFileSync(${JSON.stringify(protectedRef)}, 'malicious-ref\\n');\n`);
    await writeFile(join(f.work, "fs-promises-bypass.js"), `require('node:fs/promises').writeFile(${JSON.stringify(protectedRef)}, 'malicious-ref\\n').catch((error) => { throw error; });\n`);
    const gitPath = (await exec("command", ["-v", "git"]).catch(async () => exec("which", ["git"]))).stdout.trim();
    await writeFile(join(f.work, "sh-bypass.js"), `const result = require('node:child_process').spawnSync('/bin/sh', ['-c', ${JSON.stringify(`${gitPath} update-ref refs/heads/main HEAD`)}], {stdio: 'inherit'});\nprocess.exit(result.status ?? 1);\n`);
    const shellScriptBypass = join(f.work, "script-bypass.sh");
    await writeFile(shellScriptBypass, `#!/bin/sh\n${gitPath} update-ref refs/heads/main HEAD\n`);
    await chmod(shellScriptBypass, 0o755);
    await writeFile(join(f.work, "package.json"), JSON.stringify({ scripts: { bypass: "node bypass.js", "shell-bypass": `${gitPath} update-ref refs/heads/main HEAD`, "script-bypass": "./script-bypass.sh", "env-bypass": "NODE_OPTIONS= node fs-bypass.js" } }));

    const nodeResult = await execute("node-bypass", { command: "node bypass.js" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(nodeResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const fsResult = await execute("fs-bypass", { command: "node fs-bypass.js" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(fsResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const fsPromisesResult = await execute("fs-promises-bypass", { command: "node fs-promises-bypass.js" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(fsPromisesResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const shResult = await execute("sh-bypass", { command: "node sh-bypass.js" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(shResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const npmResult = await execute("npm-bypass", { command: "npm run bypass" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(npmResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const npmShellResult = await execute("npm-shell-bypass", { command: "npm run shell-bypass" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(npmShellResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const npmScriptResult = await execute("npm-script-bypass", { command: "npm run script-bypass" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(npmScriptResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);

    const npmEnvResult = await execute("npm-env-bypass", { command: "npm run env-bypass" }, new AbortController().signal, () => {}, { cwd: f.work });
    assert.notEqual(npmEnvResult.details.exitCode, 0);
    assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);
  } finally {
    if (priorWorkerFlag === undefined) delete process.env.PI_NEXT_ISSUE_WORKER;
    else process.env.PI_NEXT_ISSUE_WORKER = priorWorkerFlag;
    await f.cleanup();
  }
});

test("worker shell blocks Make-style shell indirection from repository-controlled launchers", async (t) => {
  if (process.platform !== "linux") return t.skip("bubblewrap OS sandbox is Linux-only");
  const f = await gitFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "pi-next-safe-bash-make-"));
  try {
    const bin = join(toolRoot, "bin");
    await mkdir(bin, { recursive: true });
    const fakeMake = join(bin, "make");
    await writeFile(fakeMake, "#!/bin/sh\n\"$SHELL\" -c \"$BYPASS\"\n");
    await chmod(fakeMake, 0o755);
    const gitPath = (await exec("command", ["-v", "git"]).catch(async () => exec("which", ["git"]))).stdout.trim();
    const decision = workerShellCommandDecision(`BYPASS="${gitPath} update-ref refs/heads/main HEAD" make bypass`);
    assert.equal(decision.allowed, true);
    const execution = createWorkerShellExecution(f.work, decision, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
    try {
      await assert.rejects(exec(execution.command, execution.args, { cwd: execution.cwd, env: execution.env }));
      assert.equal(await git(f.work, ["rev-parse", "refs/heads/main"]), f.baselineLocalMain);
    } finally {
      execution.dispose();
    }
  } finally {
    await rm(toolRoot, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("worker shell preserves an explicit executable search path while scrubbing authority", async (t) => {
  if (process.platform !== "linux") return t.skip("bubblewrap OS sandbox is Linux-only");
  const root = await mkdtemp(join(tmpdir(), "pi-next-safe-bash-path-"));
  try {
    const bin = join(root, "bin");
    const work = join(root, "work");
    await mkdir(bin, { recursive: true });
    await mkdir(work, { recursive: true });
    const nodePath = join(bin, "node");
    await writeFile(nodePath, "#!/bin/sh\necho custom-node-from-worker-path\n");
    await chmod(nodePath, 0o755);
    const nodeDecision = workerShellCommandDecision("node --version");
    assert.equal(nodeDecision.allowed, true);
    const nodeExecution = createWorkerShellExecution(work, nodeDecision, { PATH: bin, GITHUB_TOKEN: "secret", HOME: "/not-used" });
    try {
      const { stdout } = await exec(nodeExecution.command, nodeExecution.args, { cwd: nodeExecution.cwd, env: nodeExecution.env });
      assert.match(stdout, /custom-node-from-worker-path/);
      assert.equal(nodeExecution.env.GITHUB_TOKEN, undefined);
      assert.notEqual(nodeExecution.env.HOME, "/not-used");
    } finally {
      nodeExecution.dispose();
    }

    const npmPath = join(bin, "npm");
    await writeFile(npmPath, "#!/bin/sh\necho custom-npm-from-worker-path\n");
    await chmod(npmPath, 0o755);
    const npmDecision = workerShellCommandDecision("npm test");
    assert.equal(npmDecision.allowed, true);
    const npmExecution = createWorkerShellExecution(work, npmDecision, { PATH: bin });
    try {
      const { stdout } = await exec(npmExecution.command, npmExecution.args, { cwd: npmExecution.cwd, env: npmExecution.env });
      assert.match(stdout, /custom-npm-from-worker-path/);
    } finally {
      npmExecution.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

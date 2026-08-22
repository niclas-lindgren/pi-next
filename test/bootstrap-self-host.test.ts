import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  main,
  runBootstrap,
  runCommand,
  type BootstrapDependencies,
  type CommandResult,
  type Issue,
  type WorkerFactory,
  type WorkerSession,
} from "../scripts/bootstrap-self-host.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-bootstrap-") );
  const remote = `${root}.origin.git`;
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Fixture instructions\nDo not merge or close work.\n");
  await writeFile(join(root, "docs", "EVALUATION_AND_RELIABILITY.md"), "# Evaluation\nUse independent mechanical grading.\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"true","typecheck":"true"}}\n');
  await exec("git", ["init", "--initial-branch=main", root]);
  await git(root, "config", "user.email", "bootstrap@example.invalid");
  await git(root, "config", "user.name", "bootstrap test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture baseline");
  await exec("git", ["init", "--bare", remote]);
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-q", "origin", "main");
  return { root, remote, cleanup: () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(remote, { recursive: true, force: true }),
  ]).then(() => undefined) };
}

function issue(number = 75): Issue {
  return {
    number,
    title: "fixture issue",
    body: "Implement the fixture change.\n\nSee docs/EVALUATION_AND_RELIABILITY.md.",
    comments: [{ author: { login: "operator" }, body: "Keep verification independent.", createdAt: "2026-01-01T00:00:00Z" }],
  };
}

function checkResult(cwd: string, command: string, exitCode: number): CommandResult {
  return { command: "sh", args: ["-c", command], cwd, exitCode, stdout: exitCode ? "deterministic failure" : "ok", stderr: "", durationMs: 1 };
}

function dependenciesFor(
  root: string,
  workerFactory: WorkerFactory,
  checkExitCodes: () => number,
  commandLog: string[],
): BootstrapDependencies {
  return {
    fetchIssue: async () => issue(),
    createWorker: workerFactory,
    runCommand: async (command, args, options) => {
      commandLog.push(`${command} ${args.join(" ")}`);
      if (command === "sh" && args[0] === "-c" && (args[1] === "npm run typecheck" || args[1] === "npm test")) {
        return checkResult(options.cwd, args[1], checkExitCodes());
      }
      return runCommand(command, args, options);
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

function fakeFactory(
  sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }>,
  action: (role: string, cwd: string, prompt: string) => Promise<void>,
): WorkerFactory {
  return async ({ cwd, role }) => {
    const record = { role, prompt: "", disposed: false, aborted: false };
    sessions.push(record);
    const session: WorkerSession = {
      model: { provider: "fake", id: "scripted" },
      subscribe: () => () => undefined,
      prompt: async (prompt) => {
        record.prompt = prompt;
        await action(role, cwd, prompt);
      },
      abort: async () => {
        record.aborted = true;
      },
      dispose: () => {
        record.disposed = true;
      },
    };
    return session;
  };
}

test("runs one fresh worker in the canonical worktree and grades it outside the worker", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const commands: string[] = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "implemented.txt"), "implemented\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, commands),
    );

    assert.equal(report.disposition, "pass");
    assert.equal(report.attempts, 1);
    assert.equal(report.branch, "agent/issue-75");
    assert.equal(report.worktree, ".worktrees/issue-75");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.disposed, true);
    assert.match(sessions[0]!.prompt, /Keep verification independent/);
    assert.match(sessions[0]!.prompt, /Fixture instructions/);
    assert.match(sessions[0]!.prompt, /# Evaluation/);
    assert.ok(commands.some((command) => command.includes("npm run typecheck")));
    assert.ok(commands.some((command) => command.includes("npm test")));
    assert.ok(!JSON.stringify(report).includes("Fixture instructions"));
  } finally {
    await fixtureState.cleanup();
  }
});

test("uses at most one fresh repair session and passes concise failure evidence", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let checkRuns = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      await writeFile(join(cwd, `${role}.txt`), "changed\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => (checkRuns++ === 0 ? 1 : 0), []),
    );

    assert.equal(report.disposition, "pass");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "repair"]);
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0], sessions[1]);
    assert.match(sessions[1]!.prompt, /DETERMINISTIC FAILURE EVIDENCE/);
    assert.doesNotMatch(sessions[1]!.prompt, /implementation transcript|hidden reasoning/i);
    assert.ok(sessions.every((session) => session.disposed));
  } finally {
    await fixtureState.cleanup();
  }
});

test("does not merge or close when the worker is blocked", async () => {
  const fixtureState = await fixture();
  try {
    const commands: string[] = [];
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async () => {
      throw new Error("scripted worker unavailable");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, commands),
    );

    assert.equal(report.disposition, "blocked");
    assert.equal(report.reviewer, undefined);
    assert.equal(sessions.length, 1);
    assert.ok(!commands.some((command) => /(?:^| )(?:merge|push)(?: |$)|gh issue close/.test(command)));
  } finally {
    await fixtureState.cleanup();
  }
});

test("review gets a fresh read-only context and exact candidate evidence", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role !== "review") await writeFile(join(cwd, "candidate.txt"), "candidate\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.disposition, "pass");
    assert.equal(report.reviewer?.role, "review");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "review"]);
    assert.match(sessions[1]!.prompt, /EXACT CANDIDATE EVIDENCE/);
    assert.match(sessions[1]!.prompt, /REVISION:/);
    assert.match(sessions[1]!.prompt, /COMMITTED DIFF:/);
    assert.match(sessions[1]!.prompt, /Do not edit files/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("timeout aborts and disposes the fresh worker", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async () => new Promise<void>(() => undefined));
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.disposition, "blocked");
    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(sessions[0]!.aborted, true);
    assert.equal(sessions[0]!.disposed, true);
  } finally {
    await fixtureState.cleanup();
  }
});

test("rejects implicit multi-issue progression", async () => {
  assert.equal(await main(["--queue", "75,76"]), 2);
});

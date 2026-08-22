import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  BootstrapSetupError,
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

async function fixture(withLockfile = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-next-bootstrap-") );
  const remote = `${root}.origin.git`;
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Fixture instructions\nDo not merge or close work.\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n.worktrees/\n");
  await writeFile(join(root, "docs", "EVALUATION_AND_RELIABILITY.md"), "# Evaluation\nUse independent mechanical grading.\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0","scripts":{"test":"true","typecheck":"true"}}\n');
  if (withLockfile) {
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }) + "\n");
  }
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

function dependencyRunner(
  logs: string[],
  options: { validationExit?: number; installExit?: number } = {},
): BootstrapDependencies["runCommand"] {
  return async (command, args, runnerOptions) => {
    logs.push(`${command} ${args.join(" ")}`);
    if (command === "npm" && args[0] === "ls") {
      return checkResult(runnerOptions.cwd, "npm ls", options.validationExit ?? 1);
    }
    if (command === "npm" && args[0] === "ci") {
      if ((options.installExit ?? 0) === 0) await mkdir(join(runnerOptions.cwd, "node_modules"), { recursive: true });
      return checkResult(runnerOptions.cwd, "npm ci", options.installExit ?? 0);
    }
    if (command === "sh" && args[0] === "-c" && (args[1] === "npm run typecheck" || args[1] === "npm test")) {
      return checkResult(runnerOptions.cwd, args[1], 0);
    }
    return runCommand(command, args, runnerOptions);
  };
}

function lockedDependencies(
  factory: WorkerFactory,
  logs: string[],
  setup: { validationExit?: number; installExit?: number } = {},
): BootstrapDependencies {
  return {
    fetchIssue: async () => issue(),
    createWorker: factory,
    runCommand: dependencyRunner(logs, setup),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

function fakeFactory(
  sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }>,
  action: (role: string, cwd: string, prompt: string) => Promise<void>,
  stats?: () => ReturnType<NonNullable<WorkerSession["getSessionStats"]>>,
  structured?: (role: string) => unknown,
): WorkerFactory {
  return async ({ cwd, role }) => {
    const record = { role, prompt: "", disposed: false, aborted: false };
    sessions.push(record);
    let listener: ((event: unknown) => void) | undefined;
    const session: WorkerSession = {
      model: { provider: "fake", id: "scripted" },
      subscribe: (next) => {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
      prompt: async (prompt) => {
        record.prompt = prompt;
        await action(role, cwd, prompt);
        const result = structured?.(role);
        if (result !== undefined && listener) {
          const text = JSON.stringify(result);
          const split = Math.max(1, Math.floor(text.length / 2));
          for (const delta of [text.slice(0, split), text.slice(split)]) {
            if (!delta) continue;
            listener({
              type: "message_update",
              message: { role: "assistant", content: [] },
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
            });
          }
        }
      },
      abort: async () => {
        record.aborted = true;
      },
      dispose: () => {
        record.disposed = true;
      },
      getSessionStats: stats,
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
    }, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.disposition, "pass");
    assert.equal(report.reviewer?.role, "review");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "review"]);
    assert.match(sessions[1]!.prompt, /EXACT CANDIDATE EVIDENCE/);
    assert.match(sessions[1]!.prompt, /REVISION:/);
    assert.match(sessions[1]!.prompt, /COMMITTED DIFF \(MERGE_BASE\.\.HEAD\):/);
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

test("prepares lockfile dependencies before launching the worker and reports dirty candidate state", async () => {
  const fixtureState = await fixture(true);
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const events: string[] = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      events.push("worker-launched");
      await writeFile(join(cwd, "candidate.txt"), "useful work\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      lockedDependencies(factory, events),
    );

    assert.equal(report.dependencySetup.action, "installed");
    assert.equal(report.dependencySetup.manager, "npm");
    assert.ok(events.indexOf("npm ci") < events.indexOf("worker-launched"));
    assert.equal(report.candidate.headRevision, report.candidate.baselineRevision);
    assert.equal(report.candidate.dirty, true);
    assert.equal(report.candidate.uncommittedChanges, true);
    assert.equal(report.candidate.committedChanges, false);
    assert.deepEqual(report.candidate.changedFiles, ["candidate.txt"]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("dependency setup failure launches no worker and preserves the canonical worktree", async () => {
  const fixtureState = await fixture(true);
  try {
    let launches = 0;
    const factory = fakeFactory([], async () => { launches += 1; });
    await assert.rejects(
      runBootstrap(
        { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
        lockedDependencies(factory, [], { installExit: 1 }),
      ),
      (error: unknown) => error instanceof BootstrapSetupError && error.code === "DEPENDENCY_SETUP_FAILED",
    );
    assert.equal(launches, 0);
  } finally {
    await fixtureState.cleanup();
  }
});

test("reuses a valid worktree dependency installation instead of running npm ci again", async () => {
  const fixtureState = await fixture(true);
  try {
    const firstLogs: string[] = [];
    const firstFactory = fakeFactory([], async () => undefined);
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      lockedDependencies(firstFactory, firstLogs),
    );
    const secondLogs: string[] = [];
    const secondFactory = async () => { throw new Error("verify-only must not create a worker"); };
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      lockedDependencies(secondFactory, secondLogs, { validationExit: 0 }),
    );

    assert.equal(report.dependencySetup.action, "reused");
    assert.ok(secondLogs.some((entry) => entry.startsWith("npm ls")));
    assert.ok(!secondLogs.some((entry) => entry.startsWith("npm ci")));
    assert.equal(report.attempts, 0);
  } finally {
    await fixtureState.cleanup();
  }
});

test("verify-only grades preserved dirty work without an implementation turn", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const first = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "preserved.txt"), "keep me\n");
    });
    let checks = 0;
    const initialDependencies = dependenciesFor(fixtureState.root, first, () => (checks++ === 0 ? 1 : 1), []);
    const failed = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      initialDependencies,
    );
    assert.equal(failed.candidate.dirty, true);
    const verifyFactory = async () => { throw new Error("no implementation worker"); };
    const verified = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, verifyFactory, () => 0, []),
    );

    assert.equal(verified.disposition, "pass");
    assert.equal(verified.attempts, 0);
    assert.equal(verified.candidate.dirty, true);
    assert.deepEqual(verified.candidate.changedFiles, ["preserved.txt"]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("verify-only may use one bounded repair after candidate checks fail, without implementation", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let checkRuns = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role === "repair") await writeFile(join(cwd, "repair.txt"), "bounded\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => (checkRuns++ === 0 ? 1 : 0), []),
    );
    assert.equal(report.disposition, "pass");
    assert.deepEqual(sessions.map((session) => session.role), ["repair"]);
    assert.equal(report.workerAttempts.filter((attempt) => attempt.role === "implementation").length, 0);
  } finally {
    await fixtureState.cleanup();
  }
});

test("maps nested Pi token usage and flags suspicious zero-token cost telemetry", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async () => undefined, () => ({
      tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23 },
      cost: 0.42,
      toolCalls: 4,
    }));
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.deepEqual(report.workerAttempts[0]!.usage, {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23, cost: 0.42,
    });
    assert.equal(report.workerAttempts[0]!.toolCalls, 4);
    assert.equal(report.workerAttempts[0]!.telemetryWarning, undefined);
  } finally {
    await fixtureState.cleanup();
  }
});

test("marks nonzero cost with zero SDK tokens as suspicious telemetry", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async () => undefined, () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0.01,
      toolCalls: 0,
    }));
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.equal(report.workerAttempts[0]!.telemetryWarning, "SDK reported nonzero cost with zero token usage");
  } finally {
    await fixtureState.cleanup();
  }
});

test("rejects implicit multi-issue progression", async () => {
  assert.equal(await main(["--queue", "75,76"]), 2);
});

test("review evidence includes untracked file contents instead of only git diff names", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role !== "review") await writeFile(join(cwd, "src-new.ts"), "export const value = 42;\n");
    }, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.disposition, "pass");
    assert.match(sessions[1]!.prompt, /UNTRACKED FILE CONTENTS:/);
    assert.match(sessions[1]!.prompt, /--- BEGIN UNTRACKED FILE src-new\.ts ---/);
    assert.match(sessions[1]!.prompt, /export const value = 42;/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("branch at original base but behind newer origin main has zero committed candidate changes", async () => {
  const fixtureState = await fixture();
  try {
    const noWorker = async () => { throw new Error("no worker"); };
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, noWorker, () => 0, []),
    );
    await writeFile(join(fixtureState.root, "main-advanced.txt"), "main\n");
    await git(fixtureState.root, "add", "main-advanced.txt");
    await git(fixtureState.root, "commit", "-qm", "advance main");
    await git(fixtureState.root, "push", "-q", "origin", "main");

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, noWorker, () => 0, []),
    );
    assert.equal(report.candidate.committedChanges, false);
    assert.equal(report.candidate.commitsAheadOfMergeBase, 0);
    assert.equal(report.candidate.behindOriginMain, true);
    assert.equal(report.candidate.commitsBehindOriginMain, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("issue commit on old base is reported separately from newer main divergence", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "issue-commit.txt"), "issue\n");
      await git(cwd, "add", "issue-commit.txt");
      await git(cwd, "commit", "-qm", "issue commit");
    });
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    await writeFile(join(fixtureState.root, "main-advanced.txt"), "main\n");
    await git(fixtureState.root, "add", "main-advanced.txt");
    await git(fixtureState.root, "commit", "-qm", "advance main");
    await git(fixtureState.root, "push", "-q", "origin", "main");

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, async () => { throw new Error("no worker"); }, () => 0, []),
    );
    assert.equal(report.candidate.committedChanges, true);
    assert.equal(report.candidate.commitsAheadOfMergeBase, 1);
    assert.equal(report.candidate.commitsBehindOriginMain, 1);
    assert.equal(report.candidate.divergedFromOriginMain, true);
    assert.deepEqual(report.candidate.committedFiles, ["issue-commit.txt"]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("dirty tracked plus untracked plus committed evidence is complete and bounded", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role === "review") return;
      await writeFile(join(cwd, "committed.txt"), "committed\n");
      await git(cwd, "add", "committed.txt");
      await git(cwd, "commit", "-qm", "candidate commit");
      await writeFile(join(cwd, "committed.txt"), "committed\ntracked dirty\n");
      await writeFile(join(cwd, "untracked.txt"), "untracked body\n");
    }, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    const prompt = sessions[1]!.prompt;
    assert.equal(report.disposition, "pass");
    assert.ok(prompt.length < 256_000);
    assert.match(prompt, /COMMITTED DIFF \(MERGE_BASE\.\.HEAD\):/);
    assert.match(prompt, /\+committed/);
    assert.match(prompt, /UNSTAGED DIFF:/);
    assert.match(prompt, /\+tracked dirty/);
    assert.match(prompt, /untracked body/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("review refuses safely when exact untracked evidence exceeds the bound", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async (_role, cwd) => {
      await writeFile(join(cwd, "huge.txt"), "x".repeat(260_000));
    });
    await assert.rejects(
      runBootstrap(
        { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
        dependenciesFor(fixtureState.root, factory, () => 0, []),
      ),
      /bounded reviewer packet/,
    );
  } finally {
    await fixtureState.cleanup();
  }
});

test("review pass is captured as an explicit verdict", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async () => undefined, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.deepEqual(report.reviewerResult, { verdict: "pass" });
    assert.equal(report.reviewPass, true);
  } finally {
    await fixtureState.cleanup();
  }
});

test("blocking reviewer findings fail review even when worker completed", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async () => undefined, undefined, (role) => role === "review" ? { verdict: "findings", findings: [{ severity: "blocking", path: "x.ts", summary: "wrong" }] } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.equal(report.reviewer?.disposition, "completed");
    assert.equal(report.disposition, "blocked");
    assert.equal(report.reviewPass, false);
  } finally {
    await fixtureState.cleanup();
  }
});

test("malformed or absent reviewer result fails closed", async () => {
  const fixtureState = await fixture();
  try {
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, fakeFactory([], async () => undefined), () => 0, []),
    );
    assert.equal(report.reviewer?.disposition, "completed");
    assert.equal(report.reviewerResult, undefined);
    assert.equal(report.disposition, "blocked");
  } finally {
    await fixtureState.cleanup();
  }
});

test("reviewer findings are bounded and omit raw transcript fields", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async () => undefined, undefined, (role) => role === "review" ? {
      verdict: "findings",
      transcript: "hidden raw transcript",
      findings: [{ severity: "warning", summary: "a".repeat(800) }],
    } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.equal(report.disposition, "pass");
    assert.equal(report.reviewerResult?.findings?.[0]?.summary.length, 500);
    assert.ok(!JSON.stringify(report.reviewerResult).includes("hidden raw transcript"));
  } finally {
    await fixtureState.cleanup();
  }
});

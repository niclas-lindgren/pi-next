import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  BootstrapSetupError,
  bootstrapWorkerSettingsOverridesFromEnv,
  createBootstrapWorkerSettingsManager,
  fetchRoadmapIssues,
  main,
  resolveNextIssue,
  runBootstrap,
  runBootstrapCli,
  runBootstrapLifecycle,
  runCommand,
  runWorker,
  type BootstrapDependencies,
  type BootstrapProgressEvent,
  type CommandResult,
  type Issue,
  type RoadmapIssue,
  type WorkerFactory,
  type WorkerReport,
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

test("bootstrap worker settings honor Pi defaults and current interactive model", () => {
  let createArgs: { cwd: string; agentDir: string } | undefined;
  let inMemoryCalled = false;
  const settingsManager = {
    overrides: [] as unknown[],
    applyOverrides(overrides: unknown) { this.overrides.push(overrides); },
  };
  const sdk = {
    SettingsManager: {
      create: (cwd: string, agentDir: string) => {
        createArgs = { cwd, agentDir };
        return settingsManager;
      },
      inMemory: () => {
        inMemoryCalled = true;
        return settingsManager;
      },
    },
  };

  assert.equal(createBootstrapWorkerSettingsManager(sdk, "/repo", "/agent", {
    PI_PROVIDER: "openai-codex",
    PI_MODEL: "gpt-5.5",
    PI_REASONING_LEVEL: "high",
  }), settingsManager);
  assert.deepEqual(createArgs, { cwd: "/repo", agentDir: "/agent" });
  assert.equal(inMemoryCalled, false);
  assert.deepEqual(settingsManager.overrides, [{
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.5",
    defaultThinkingLevel: "high",
  }]);

  assert.deepEqual(bootstrapWorkerSettingsOverridesFromEnv({}), {
    compaction: { enabled: false },
    retry: { enabled: false },
  });
});

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
        listener?.({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
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
    assert.match(sessions[1]!.prompt, /EXACT CANDIDATE EVIDENCE/);
    assert.match(sessions[1]!.prompt, /implementation\.txt/);
    assert.doesNotMatch(sessions[1]!.prompt, /implementation transcript|hidden reasoning/i);
    assert.ok(sessions.every((session) => session.disposed));
  } finally {
    await fixtureState.cleanup();
  }
});

test("#79 regression shape: typecheck passes, npm test fails, then fresh automatic repair runs", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let testRuns = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      await writeFile(join(cwd, role === "implementation" ? "lifecycle-model-property.test.ts" : "bootstrap-self-host.test.ts"), "changed\n");
    });
    const commands: string[] = [];
    const report = await runBootstrap(
      { issueNumber: 79, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 5_000 },
      {
        ...dependenciesFor(fixtureState.root, factory, () => 0, commands),
        fetchIssue: async () => issue(79),
        runCommand: async (command, args, options) => {
          commands.push(`${command} ${args.join(" ")}`);
          if (command === "sh" && args[0] === "-c" && args[1] === "npm run typecheck") return checkResult(options.cwd, args[1], 0);
          if (command === "sh" && args[0] === "-c" && args[1] === "npm test") return checkResult(options.cwd, args[1], testRuns++ === 0 ? 1 : 0);
          return runCommand(command, args, options);
        },
      },
    );

    assert.equal(report.disposition, "pass");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "repair"]);
    assert.match(sessions[1]!.prompt, /npm test/);
    assert.match(sessions[1]!.prompt, /lifecycle-model-property\.test\.ts/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("automatic repair stops after one failed repair verification and preserves candidate", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let checkRuns = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      await writeFile(join(cwd, `${role}.txt`), "changed\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => (checkRuns++ < 4 ? 1 : 0), []),
    );

    assert.equal(report.disposition, "repairable-failure");
    assert.equal(report.repairOutcome, "exhausted");
    assert.equal(report.repairBudgetExhausted, true);
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "repair"]);
    assert.equal(report.checks.some((check) => !check.passed), true);
    assert.deepEqual(report.candidate.changedFiles.sort(), ["implementation.txt", "repair.txt"]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("does not automatically repair an unproven no-change verification failure after zero-delta retry exhaustion", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async () => undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 1, []),
    );

    assert.equal(report.disposition, "repairable-failure");
    assert.equal(report.repairOutcome, "ineligible");
    assert.equal(report.implementationOutcome, "retry-exhausted");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "implementation-retry"]);
    assert.equal(report.candidateHasDelta, false);
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

test("timed-out worker with tracked and untracked verified delta is recovered as implemented", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "docs", "EVALUATION_AND_RELIABILITY.md"), "# Evaluation\nRecovered after timeout.\n");
      await writeFile(join(cwd, "timeout-untracked.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(report.workerAttempts[0]!.assistantOutputObserved, false);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.disposition, "pass");
    assert.equal(report.finalizationReady, true);
    assert.equal(report.candidateReadyForReview, true);
    assert.equal(report.implementationAttemptCount, 1);
    assert.equal(sessions.length, 1);
    assert.deepEqual(report.candidate.changedFiles.sort(), ["docs/EVALUATION_AND_RELIABILITY.md", "timeout-untracked.txt"]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("timed-out worker with zero delta remains blocked as an implementation failure", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async () => new Promise<void>(() => undefined));
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(report.candidateHasDelta, false);
    assert.equal(report.implementationOutcome, "failed");
    assert.equal(report.finalizationReady, false);
    assert.equal(report.disposition, "blocked");
  } finally {
    await fixtureState.cleanup();
  }
});

test("timed-out worker with delta and failing checks can spend the normal bounded repair", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let checkRuns = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role === "implementation") {
        await writeFile(join(cwd, "timeout-needs-repair.txt"), "candidate\n");
        await new Promise<void>(() => undefined);
      }
      await writeFile(join(cwd, "timeout-repair.txt"), "repair\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => (checkRuns++ === 0 ? 1 : 0), []),
    );

    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "repair"]);
    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(report.repairOutcome, "completed");
    assert.equal(report.mechanicalPass, true);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.finalizationReady, true);
  } finally {
    await fixtureState.cleanup();
  }
});

test("timed-out worker with delta but failing checks is a verification failure, not a successful implementation", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "timeout-failing.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => 1, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(report.candidateHasDelta, true);
    assert.equal(report.mechanicalPass, false);
    assert.equal(report.implementationOutcome, "failed");
    assert.equal(report.disposition, "repairable-failure");
    assert.match(report.failureReason ?? "", /npm run typecheck|deterministic failure/);
    assert.doesNotMatch(report.failureReason ?? "", /timed out/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("timed-out verified candidate still runs independent review when review is enabled", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (role, cwd) => {
      if (role === "review") return;
      await writeFile(join(cwd, "timeout-reviewed.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    }, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "review"]);
    assert.equal(report.workerAttempts[0]!.disposition, "timed_out");
    assert.equal(report.reviewer?.disposition, "completed");
    assert.equal(report.reviewPass, true);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.finalizationReady, true);
    assert.equal(report.disposition, "pass");
  } finally {
    await fixtureState.cleanup();
  }
});

test("operator cancellation is not reinterpreted as autonomous candidate success", async () => {
  const fixtureState = await fixture();
  try {
    const controller = new AbortController();
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "cancelled-candidate.txt"), "candidate\n");
      controller.abort();
      await new Promise<void>(() => undefined);
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000, signal: controller.signal },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "cancelled");
    assert.equal(report.candidateHasDelta, true);
    assert.equal(report.mechanicalPass, true);
    assert.equal(report.implementationOutcome, "failed");
    assert.equal(report.finalizationReady, false);
    assert.equal(report.candidateReadyForReview, false);
    assert.equal(report.disposition, "blocked");
  } finally {
    await fixtureState.cleanup();
  }
});

test("preserved timed-out verified candidate resumes without a new implementation worker", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const firstFactory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "resume-timeout.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    });
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, firstFactory, () => 0, []),
    );

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, async () => { throw new Error("implementation worker must not relaunch"); }, () => 0, []),
    );

    assert.equal(report.attempts, 0);
    assert.equal(report.implementationAttemptCount, 0);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.finalizationReady, true);
    assert.equal(report.disposition, "pass");
    assert.equal(sessions.length, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("timed-out verified candidate behind origin main remains freshness-blocked for finalization", async () => {
  const fixtureState = await fixture();
  try {
    const firstFactory = fakeFactory([], async (_role, cwd) => {
      await writeFile(join(cwd, "behind-timeout.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    });
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, firstFactory, () => 0, []),
    );
    await writeFile(join(fixtureState.root, "main-after-timeout.txt"), "main\n");
    await git(fixtureState.root, "add", "main-after-timeout.txt");
    await git(fixtureState.root, "commit", "-qm", "advance main after timeout");
    await git(fixtureState.root, "push", "-q", "origin", "main");

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, async () => { throw new Error("implementation worker must not relaunch"); }, () => 0, []),
    );

    assert.equal(report.attempts, 0);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.candidate.behindOriginMain, true);
    assert.equal(report.finalizationReady, false);
  } finally {
    await fixtureState.cleanup();
  }
});

test("incident diagnostics in coordination root are committed and bootstrap proceeds from preflight", async () => {
  const fixtureState = await fixture();
  try {
    const diagnostics = join(fixtureState.root, ".pi-next", "diagnostics", "incidents");
    await mkdir(diagnostics, { recursive: true });
    await writeFile(join(diagnostics, "last.json"), "{\"ok\":1}\n");
    await git(fixtureState.root, "add", ".pi-next/diagnostics/incidents/last.json");
    await git(fixtureState.root, "commit", "-qm", "seed tracked incident diagnostic");
    await git(fixtureState.root, "push", "-q", "origin", "main");
    await writeFile(join(diagnostics, "last.json"), "{\"ok\":2}\n");
    await writeFile(join(diagnostics, "2026-08-26T06-49-30.973Z-69982a575fa4.json"), "{\"ok\":3}\n");
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const commands: string[] = [];
    const factory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "implemented-after-diagnostics.txt"), "implemented\n");
    });

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, commands),
    );

    assert.equal(report.disposition, "pass");
    assert.equal(sessions.length, 1);
    assert.equal(await git(fixtureState.root, "status", "--porcelain"), "");
    assert.equal(await git(fixtureState.remote, "show", "main:.pi-next/diagnostics/incidents/last.json"), "{\"ok\":2}");
    assert.equal(await git(fixtureState.remote, "show", "main:.pi-next/diagnostics/incidents/2026-08-26T06-49-30.973Z-69982a575fa4.json"), "{\"ok\":3}");
    assert.match(await git(fixtureState.root, "log", "--format=%s", "-1", "main"), /record finalization incident diagnostics/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("dirty coordination root still blocks fresh bootstrap work without a canonical candidate", async () => {
  const fixtureState = await fixture();
  try {
    await writeFile(join(fixtureState.root, "operator-root-note.txt"), "leave me alone\n");
    const commands: string[] = [];
    await assert.rejects(
      runBootstrap(
        { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
        dependenciesFor(fixtureState.root, fakeFactory([], async () => undefined), () => 0, commands),
      ),
      /coordination checkout is dirty/,
    );
    assert.ok(!commands.some((command) => command.includes("fetch origin main")));
    assert.equal(await readFile(join(fixtureState.root, "operator-root-note.txt"), "utf8"), "leave me alone\n");
  } finally {
    await fixtureState.cleanup();
  }
});

test("dirty coordination root does not block resume of preserved timed-out candidate", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const firstFactory = fakeFactory(sessions, async (_role, cwd) => {
      await writeFile(join(cwd, "dirty-root-resume.txt"), "candidate\n");
      await new Promise<void>(() => undefined);
    });
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 10 },
      dependenciesFor(fixtureState.root, firstFactory, () => 0, []),
    );
    await writeFile(join(fixtureState.root, "operator-root-note.txt"), "leave me alone\n");

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, async () => { throw new Error("implementation worker must not relaunch"); }, () => 0, []),
    );

    assert.equal(report.attempts, 0);
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.finalizationReady, true);
    assert.equal(await readFile(join(fixtureState.root, "operator-root-note.txt"), "utf8"), "leave me alone\n");
    assert.match(await git(fixtureState.root, "status", "--porcelain"), /operator-root-note\.txt/);
    assert.equal(sessions.length, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("#145/#132 regression: a resolved prompt with zero tools/tokens and no terminal model result is not misclassified as completed", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory: WorkerFactory = async ({ cwd }) => {
      const record = { role: "implementation", prompt: "", disposed: false, aborted: false };
      sessions.push(record);
      return {
        model: { provider: "openai-codex", id: "gpt-5.5" },
        subscribe: () => () => undefined,
        prompt: async () => {
          void cwd;
          // Resolves with no tool activity, no tokens, and no observed terminal
          // assistant result - the exact #145/#132 false-completion shape.
        },
        dispose: () => { record.disposed = true; },
        getSessionStats: () => ({ toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      };
    };
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "failed");
    assert.notEqual(report.workerAttempts[0]!.disposition, "completed");
    assert.match(report.workerAttempts[0]!.reason ?? "", /MODEL_TURN_UNPROVEN/);
    assert.equal(report.implementationOutcome, "failed");
    assert.notEqual(report.implementationOutcome, "unproven-no-change");
    assert.equal(report.disposition, "blocked");
    assert.equal(sessions[0]!.disposed, true);
  } finally {
    await fixtureState.cleanup();
  }
});

test("a terminal provider error surfaces as a typed worker failure rather than completed", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory: WorkerFactory = async () => {
      const record = { role: "implementation", prompt: "", disposed: false, aborted: false };
      sessions.push(record);
      let listener: ((event: unknown) => void) | undefined;
      return {
        model: { provider: "openai-codex", id: "gpt-5.5" },
        subscribe: (next) => { listener = next; return () => { if (listener === next) listener = undefined; }; },
        prompt: async () => {
          listener?.({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "upstream provider 503" } });
        },
        dispose: () => { record.disposed = true; },
      };
    };
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.equal(report.workerAttempts[0]!.disposition, "failed");
    assert.match(report.workerAttempts[0]!.reason ?? "", /MODEL_TURN_FAILED/);
    assert.match(report.workerAttempts[0]!.reason ?? "", /upstream provider 503/);
    assert.equal(report.implementationOutcome, "failed");
  } finally {
    await fixtureState.cleanup();
  }
});

test("a worker execution failure does not consume the zero-delta implementation retry budget", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string }> = [];
    const factory: WorkerFactory = async ({ role }) => {
      sessions.push({ role });
      return {
        model: { provider: "openai-codex", id: "gpt-5.5" },
        subscribe: () => () => undefined,
        prompt: async () => undefined,
        dispose: () => undefined,
      };
    };
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );

    assert.deepEqual(sessions.map((session) => session.role), ["implementation"]);
    assert.equal(report.implementationOutcome, "failed");
  } finally {
    await fixtureState.cleanup();
  }
});

test("two concurrent worker sessions retain isolated terminal-result classification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-worker-concurrency-"));
  try {
    const failingFactory: WorkerFactory = async () => {
      let listener: ((event: unknown) => void) | undefined;
      return {
        model: { provider: "fake", id: "failing" },
        subscribe: (next) => { listener = next; return () => { if (listener === next) listener = undefined; }; },
        prompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          listener?.({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "session A failure" } });
        },
        dispose: () => undefined,
      };
    };
    const succeedingFactory: WorkerFactory = async () => {
      let listener: ((event: unknown) => void) | undefined;
      return {
        model: { provider: "fake", id: "succeeding" },
        subscribe: (next) => { listener = next; return () => { if (listener === next) listener = undefined; }; },
        prompt: async () => {
          listener?.({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
        },
        dispose: () => undefined,
      };
    };
    const reportsA: WorkerReport[] = [];
    const reportsB: WorkerReport[] = [];
    const [reportA, reportB] = await Promise.all([
      runWorker(failingFactory, "implementation", "task A", cwd, 5_000, reportsA, 1, undefined, 0),
      runWorker(succeedingFactory, "implementation", "task B", cwd, 5_000, reportsB, 2, undefined, 0),
    ]);

    assert.equal(reportA.disposition, "failed");
    assert.match(reportA.reason ?? "", /session A failure/);
    assert.equal(reportB.disposition, "completed");
    assert.equal(reportB.reason, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
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

test("normal rerun with preserved candidate verifies and finalizes without relaunching implementation", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, fakeFactory(sessions, async (_role, cwd) => {
        await writeFile(join(cwd, "resume.txt"), "candidate\n");
      }), () => 0, []),
    );
    let finalizations = 0;
    const report = await runBootstrapLifecycle(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000, finalize: true },
      {
        ...dependenciesFor(fixtureState.root, async () => { throw new Error("implementation worker must not relaunch"); }, () => 0, []),
        runFinalizer: async (options) => {
          finalizations += 1;
          assert.deepEqual(options.candidatePaths, ["resume.txt"]);
          return { ok: true, issueNumber: 75, branch: "agent/issue-75", candidateSha: "sha", merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, outcome: "finalized" };
        },
      },
    );
    assert.equal(report.finalization, "PASS");
    assert.equal(report.implementationReport.attempts, 0);
    assert.equal(finalizations, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("successful automatic repair continues into normal finalization", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let checkRuns = 0;
    let finalizations = 0;
    const factory = fakeFactory(sessions, async (role, cwd) => {
      await writeFile(join(cwd, `${role}.txt`), "changed\n");
    });
    const report = await runBootstrapLifecycle(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: true, review: false, timeoutMs: 5_000, finalize: true },
      {
        ...dependenciesFor(fixtureState.root, factory, () => (checkRuns++ === 0 ? 1 : 0), []),
        runFinalizer: async (options) => {
          finalizations += 1;
          assert.deepEqual(options.candidatePaths?.sort(), ["implementation.txt", "repair.txt"]);
          return { ok: true, issueNumber: 75, branch: "agent/issue-75", candidateSha: "sha", merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, outcome: "finalized" };
        },
      },
    );

    assert.equal(report.finalization, "PASS");
    assert.equal(report.repair, "COMPLETED");
    assert.deepEqual(sessions.map((session) => session.role), ["implementation", "repair"]);
    assert.equal(finalizations, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("verify-only may use one bounded explicit repair after preserved candidate checks fail, without implementation", async () => {
  const fixtureState = await fixture();
  try {
    const setupFactory = fakeFactory([], async (_role, cwd) => {
      await writeFile(join(cwd, "preserved-for-repair.txt"), "candidate\n");
    });
    await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, setupFactory, () => 1, []),
    );

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

function roadmap(items: Array<Partial<RoadmapIssue> & { number: number }>): RoadmapIssue[] {
  return items.map((item) => ({
    number: item.number,
    title: item.title ?? `issue ${item.number}`,
    body: item.body ?? "",
    comments: item.comments ?? [],
    state: item.state ?? "OPEN",
    labels: item.labels ?? [],
  }));
}

function authorityIssue(number: number, state?: "OPEN" | "CLOSED"): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    comments: [],
    ...(state ? { state } : {}),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("roadmap discovery preserves row order without treating dependency references as candidates", async () => {
  const viewed: number[] = [];
  const result = await fetchRoadmapIssues(process.cwd(), async (command, args, options) => {
    assert.equal(command, "gh");
    assert.deepEqual(args.slice(0, 3), ["issue", "view", args[2]]);
    const number = Number(args[2]);
    viewed.push(number);
    const payload = number === 73
      ? {
          number: 73,
          title: "roadmap",
          body: [
            "Roadmap prose mentions #90 and issue #91 but is not a backlog row.",
            "Dependency diagram: #78 -> #79 -> #80",
            "```md",
            "1. **#999 — fenced example must not become roadmap order**",
            "- #998 also fenced",
            "```",
            "1. **#74 — bootstrap foundation**",
            "2. [x] **#75 — candidate loop**",
            "3. **#76 — verification pass**",
            "4. **#77 — next repair**",
            "- [ ] **#79 — ready**",
            "* #80 blocked by #78/#79",
          ].join("\n"),
          comments: [],
          state: "OPEN",
          labels: [],
        }
      : { number, title: `issue ${number}`, body: "", comments: [], state: number <= 76 ? "CLOSED" : "OPEN", labels: [] };
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: JSON.stringify(payload), stderr: "", durationMs: 1 };
  });

  assert.deepEqual(viewed, [73, 74, 75, 76, 77, 79, 80]);
  assert.deepEqual(result.map((item) => item.number), [74, 75, 76, 77, 79, 80]);
});

function roadmapRunner(roadmapBody: string, overrides: Record<number, Partial<RoadmapIssue>> = {}) {
  return async (command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }) => {
    assert.equal(command, "gh");
    const number = Number(args[2]);
    const payload = number === 73
      ? { number: 73, title: "roadmap", body: roadmapBody, comments: [], state: "OPEN", labels: [] }
      : {
          number,
          title: `issue ${number}`,
          body: "",
          comments: [],
          state: "OPEN",
          labels: [],
          ...overrides[number],
        };
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: JSON.stringify(payload), stderr: "", durationMs: 1 };
  };
}

test("real #73 numbered-list roadmap shape skips closed items and selects reopened #77", async () => {
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: (cwd) => fetchRoadmapIssues(cwd, roadmapRunner([
      "Intro mentions #100 and dependency diagram #76 -> #77; neither is a row.",
      "1. **#74 — bootstrap foundation**",
      "2. **#75 — implementation loop**",
      "3. **#76 — deterministic verification**",
      "4. **#77 — reopened next candidate**",
    ].join("\n"), {
      74: { state: "CLOSED" },
      75: { state: "CLOSED" },
      76: { state: "CLOSED" },
      77: { state: "OPEN" },
    })),
  });

  assert.equal(selection.selectedIssueNumber, 77);
  assert.deepEqual(selection.skips.map((skip) => [skip.issueNumber, skip.status]), [[74, "closed"], [75, "closed"], [76, "closed"]]);
});

test("automatic selection skips closed predecessors and chooses the first dependency-ready open roadmap issue", async () => {
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 75, state: "CLOSED" },
      { number: 76, state: "CLOSED" },
      { number: 79, body: "Dependencies: #75, #76" },
      { number: 80, body: "Depends on #79" },
    ]),
  });
  assert.equal(selection.selectedIssueNumber, 79);
  assert.deepEqual(selection.skips.map((skip) => [skip.issueNumber, skip.status]), [[75, "closed"], [76, "closed"]]);
});

test("open dependencies block dependents until the dependency closes", async () => {
  const blocked = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 79, labels: ["blocked"] },
      { number: 80, body: "Depends on #79" },
    ]),
  });
  assert.equal(blocked.selectedIssueNumber, undefined);
  assert.equal(blocked.skips[1]?.reason, "blocked by #79");

  const ready = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 79, state: "CLOSED" },
      { number: 80, body: "Depends on #79" },
    ]),
  });
  assert.equal(ready.selectedIssueNumber, 80);
});

test("closed out-of-roadmap dependencies satisfy roadmap candidates without becoming schedulable", async () => {
  const authorityCalls: number[] = [];
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 108, body: "Depends on: #113" },
    ]),
    fetchIssue: async (issueNumber) => {
      authorityCalls.push(issueNumber);
      return authorityIssue(issueNumber, "CLOSED");
    },
  });

  assert.equal(selection.selectedIssueNumber, 108);
  assert.deepEqual(selection.skips, []);
  assert.deepEqual(authorityCalls, [113]);
  assert.notEqual(selection.selectedIssueNumber, 113);
});

test("open out-of-roadmap dependencies block only their candidate and selection continues", async () => {
  const authorityCalls: number[] = [];
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 108, body: "Depends on: #113" },
      { number: 109, body: "Dependencies: none" },
    ]),
    fetchIssue: async (issueNumber) => {
      authorityCalls.push(issueNumber);
      return authorityIssue(issueNumber, "OPEN");
    },
  });

  assert.equal(selection.selectedIssueNumber, 109);
  assert.deepEqual(selection.skips, [{ issueNumber: 108, status: "blocked", reason: "blocked by #113" }]);
  assert.deepEqual(authorityCalls, [113]);
  assert.notEqual(selection.selectedIssueNumber, 113);
});

test("multiple closed out-of-roadmap dependencies are all evaluated before selecting the candidate", async () => {
  const authorityCalls: number[] = [];
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 108, body: "Dependencies: #113, #114" },
    ]),
    fetchIssue: async (issueNumber) => {
      authorityCalls.push(issueNumber);
      return authorityIssue(issueNumber, "CLOSED");
    },
  });

  assert.equal(selection.selectedIssueNumber, 108);
  assert.deepEqual(authorityCalls, [113, 114]);
});

test("mixed closed and open out-of-roadmap dependencies block by the open dependency", async () => {
  const authorityState = new Map<number, "OPEN" | "CLOSED">([[113, "CLOSED"], [114, "OPEN"]]);
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 108, body: "Dependencies: #113, #114" },
      { number: 109 },
    ]),
    fetchIssue: async (issueNumber) => authorityIssue(issueNumber, authorityState.get(issueNumber) ?? "OPEN"),
  });

  assert.equal(selection.selectedIssueNumber, 109);
  assert.deepEqual(selection.skips, [{ issueNumber: 108, status: "blocked", reason: "blocked by #114" }]);
});

test("missing out-of-roadmap dependency authority fails closed with an explicit authority error", async () => {
  await assert.rejects(
    resolveNextIssue(process.cwd(), {
      fetchRoadmapIssues: async () => roadmap([
        { number: 108, body: "Depends on: #113" },
        { number: 109 },
      ]),
      fetchIssue: async () => { throw new Error("not found"); },
    }),
    /dependency authority lookup for #113 required by #108 failed: not found/,
  );

  await assert.rejects(
    resolveNextIssue(process.cwd(), {
      fetchRoadmapIssues: async () => roadmap([
        { number: 108, body: "Depends on: #113" },
      ]),
      fetchIssue: async () => authorityIssue(113),
    }),
    /dependency authority for #113 required by #108 is missing a resolvable state/,
  );
});

test("historical #108 regression permits completed #113/#114 follow-up dependencies outside #73 roadmap", async () => {
  const authorityCalls: number[] = [];
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 106, state: "CLOSED" },
      { number: 107, state: "CLOSED" },
      { number: 108, body: "Dependencies: #107, #106, #113 and #114" },
    ]),
    fetchIssue: async (issueNumber) => {
      authorityCalls.push(issueNumber);
      return authorityIssue(issueNumber, "CLOSED");
    },
  });

  assert.equal(selection.selectedIssueNumber, 108);
  assert.deepEqual(selection.skips.map((skip) => [skip.issueNumber, skip.status]), [[106, "closed"], [107, "closed"]]);
  assert.deepEqual(authorityCalls, [113, 114]);
});

test("multiline dependency sections block through the next markdown heading", async () => {
  const blocked = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 76, labels: ["on-hold"] },
      { number: 77, body: "## Depends on\n\n#76\n\n## Notes\nMentions #999 as prose only." },
    ]),
  });
  assert.equal(blocked.selectedIssueNumber, undefined);
  assert.equal(blocked.skips[1]?.reason, "blocked by #76");

  const ready = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 76, state: "CLOSED" },
      { number: 77, body: "## Depends on\n\n#76\n\n## Notes\nMentions #999 as prose only." },
    ]),
  });
  assert.equal(ready.selectedIssueNumber, 77);
});

test("fenced code and ordinary dependency prose are ignored by dependency parsing", async () => {
  const authorityCalls: number[] = [];
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      {
        number: 107,
        body: [
          "This issue discusses dependencies and requires careful setup in prose only.",
          "```text",
          "dependencies.ts              # npm/pnpm/yarn setup",
          "Depends on: #999",
          "#123",
          "Blocked by: #998",
          "```",
          "Documentation later mentions blocked work without declaring metadata.",
        ].join("\n"),
      },
    ]),
    fetchIssue: async (issueNumber) => {
      authorityCalls.push(issueNumber);
      throw new Error("prose or fenced references must not be fetched as dependencies");
    },
  });
  assert.equal(selection.selectedIssueNumber, 107);
  assert.deepEqual(selection.skips, []);
  assert.deepEqual(authorityCalls, []);
});

test("dependency metadata supports anchored inline declarations and explicit none", async () => {
  const inline = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 76, state: "CLOSED" },
      { number: 77, body: "Depends on: #76" },
      { number: 78, body: "Dependencies: none" },
    ]),
  });
  assert.equal(inline.selectedIssueNumber, 77);

  const none = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([
      { number: 78, body: "Dependencies: none" },
    ]),
  });
  assert.equal(none.selectedIssueNumber, 78);
});

test("malformed and conflicting explicit dependency declarations fail closed", async () => {
  await assert.rejects(
    resolveNextIssue(process.cwd(), {
      fetchRoadmapIssues: async () => roadmap([
        { number: 76, state: "CLOSED" },
        { number: 77, body: "## Dependencies\nThe previous bootstrap issue." },
      ]),
    }),
    /ambiguous dependency metadata/,
  );

  await assert.rejects(
    resolveNextIssue(process.cwd(), {
      fetchRoadmapIssues: async () => roadmap([
        { number: 76, state: "CLOSED" },
        { number: 77, body: "Dependencies: none\nDepends on: #76" },
      ]),
    }),
    /ambiguous dependency metadata/,
  );
});

test("roadmap order wins when multiple items are dependency-ready", async () => {
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([{ number: 90 }, { number: 81 }, { number: 82 }]),
  });
  assert.equal(selection.selectedIssueNumber, 90);
});

test("no eligible item is a bounded no-work result", async () => {
  const selection = await resolveNextIssue(process.cwd(), {
    fetchRoadmapIssues: async () => roadmap([{ number: 75, state: "CLOSED" }, { number: 76, labels: ["on-hold"] }]),
  });
  assert.equal(selection.selectedIssueNumber, undefined);
  assert.equal(selection.skips.length, 2);
});

test("malformed anchored dependency metadata fails closed", async () => {
  await assert.rejects(
    resolveNextIssue(process.cwd(), {
      fetchRoadmapIssues: async () => roadmap([{ number: 79, body: "Depends on:" }]),
    }),
    /ambiguous dependency metadata/,
  );
});

test("explicit --issue bypasses automatic selection and remains unchanged", async () => {
  const fixtureState = await fixture();
  try {
    const calls: number[] = [];
    const finalizations: number[] = [];
    const code = await runBootstrapCli(["--cwd", fixtureState.root, "--issue", "85"], {
      fetchRoadmapIssues: async () => { throw new Error("selection should not run"); },
      runFinalizer: async (options) => {
        finalizations.push(options.issueNumber ?? 0);
        return { ok: true, issueNumber: options.issueNumber ?? 0, branch: "agent/issue-85", candidateSha: "r", merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, outcome: "finalized" };
      },
    }, async (options) => {
      calls.push(options.issueNumber);
      return {
        issueNumber: options.issueNumber,
        attempts: 0,
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T00:00:00.000Z",
        disposition: "pass",
        branch: "agent/issue-85",
        worktree: ".worktrees/issue-85",
        revision: "r",
        baselineRevision: "b",
        candidate: {} as never,
        dependencySetup: { action: "not-required" },
        workerAttempts: [],
        checks: [],
        mechanicalPass: true,
        candidateReadyForReview: true,
        finalizationReady: true,
        implementationOutcome: "implemented",
        candidateHasDelta: true,
      };
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [85]);
    assert.deepEqual(finalizations, [85]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("CLI enables one automatic repair by default and --no-repair opts out", async () => {
  const fixtureState = await fixture();
  try {
    const observed: boolean[] = [];
    const baseReport = (options: { issueNumber: number }) => ({
      issueNumber: options.issueNumber,
      attempts: 1,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:00.000Z",
      disposition: "pass" as const,
      branch: "agent/issue-85",
      worktree: ".worktrees/issue-85",
      revision: "r",
      baselineRevision: "b",
      candidate: { changedFiles: ["candidate.txt"] } as never,
      dependencySetup: { action: "not-required" as const },
      workerAttempts: [],
      checks: [],
      mechanicalPass: true,
      candidateReadyForReview: true,
      finalizationReady: false,
      implementationOutcome: "implemented" as const,
      candidateHasDelta: true,
    });

    assert.equal(await runBootstrapCli(["--cwd", fixtureState.root, "--issue", "85", "--no-finalize"], {}, async (options) => {
      observed.push(options.allowRepair);
      return baseReport(options);
    }), 0);
    assert.equal(await runBootstrapCli(["--cwd", fixtureState.root, "--issue", "85", "--no-repair", "--no-finalize"], {}, async (options) => {
      observed.push(options.allowRepair);
      return baseReport(options);
    }), 0);

    assert.deepEqual(observed, [true, false]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("--next-only launches zero workers or bootstrap executions", async () => {
  let executions = 0;
  const code = await runBootstrapCli(["--next-only"], {
    fetchRoadmapIssues: async () => roadmap([{ number: 79 }]),
  }, async () => {
    executions += 1;
    throw new Error("no worker/model should launch");
  });
  assert.equal(code, 0);
  assert.equal(executions, 0);
});

test("--next-only uses out-of-roadmap dependency authority without lifecycle mutation or model calls", async () => {
  const fixtureState = await fixture();
  try {
    let executions = 0;
    let finalizations = 0;
    let workers = 0;
    const authorityCalls: number[] = [];
    const code = await runBootstrapCli(["--cwd", fixtureState.root, "--next-only"], {
      fetchRoadmapIssues: async () => roadmap([
        { number: 108, body: "Depends on: #113" },
      ]),
      fetchIssue: async (issueNumber) => {
        authorityCalls.push(issueNumber);
        return authorityIssue(issueNumber, "CLOSED");
      },
      createWorker: async () => {
        workers += 1;
        throw new Error("no model worker should launch for --next-only");
      },
      runFinalizer: async () => {
        finalizations += 1;
        throw new Error("no lifecycle finalization should run for --next-only");
      },
    }, async () => {
      executions += 1;
      throw new Error("no bootstrap execution should launch for --next-only");
    });

    assert.equal(code, 0);
    assert.equal(executions, 0);
    assert.equal(finalizations, 0);
    assert.equal(workers, 0);
    assert.deepEqual(authorityCalls, [113]);
    assert.equal(await pathExists(join(fixtureState.root, ".git", "pi-next")), false);
  } finally {
    await fixtureState.cleanup();
  }
});

test("--next-only evaluates the real #73/#107 fenced dependency shape without ambiguity or model calls", async () => {
  let executions = 0;
  const code = await runBootstrapCli(["--next-only"], {
    fetchRoadmapIssues: async () => roadmap([
      { number: 100, state: "CLOSED" },
      {
        number: 107,
        body: [
          "## Goal",
          "Decompose bootstrap setup.",
          "",
          "```text",
          "dependencies.ts              # npm/pnpm/yarn setup",
          "Depends on: #999",
          "#123",
          "```",
          "",
          "Prose mentions dependency parsing and requires no lifecycle metadata.",
        ].join("\n"),
      },
    ]),
  }, async () => {
    executions += 1;
    throw new Error("no worker/model should launch");
  });
  assert.equal(code, 0);
  assert.equal(executions, 0);
});

test("automatic selection invokes the existing single-issue bootstrap path once after closed external dependencies", async () => {
  const fixtureState = await fixture();
  try {
    const calls: number[] = [];
    const finalizations: number[] = [];
    const authorityCalls: number[] = [];
    const selectedFixtureIssue = 108;
    const code = await runBootstrapCli(["--cwd", fixtureState.root], {
      fetchRoadmapIssues: async () => roadmap([{ number: selectedFixtureIssue, body: "Depends on: #113" }, { number: 82 }]),
      fetchIssue: async (issueNumber) => {
        authorityCalls.push(issueNumber);
        return authorityIssue(issueNumber, "CLOSED");
      },
      runFinalizer: async (options) => {
        finalizations.push(options.issueNumber ?? 0);
        return { ok: true, issueNumber: options.issueNumber ?? 0, branch: `agent/issue-${selectedFixtureIssue}`, candidateSha: "r", merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, outcome: "finalized" };
      },
    }, async (options) => {
      calls.push(options.issueNumber);
      return {
        issueNumber: options.issueNumber,
        attempts: 1,
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T00:00:00.000Z",
        disposition: "pass",
        branch: `agent/issue-${selectedFixtureIssue}`,
        worktree: `.worktrees/issue-${selectedFixtureIssue}`,
        revision: "r",
        baselineRevision: "b",
        candidate: {} as never,
        dependencySetup: { action: "not-required" },
        workerAttempts: [],
        checks: [],
        mechanicalPass: true,
        candidateReadyForReview: true,
        finalizationReady: true,
        implementationOutcome: "implemented",
        candidateHasDelta: true,
      };
    });
    assert.equal(code, 0);
    assert.deepEqual(authorityCalls, [113]);
    assert.deepEqual(calls, [selectedFixtureIssue]);
    assert.deepEqual(finalizations, [selectedFixtureIssue]);
  } finally {
    await fixtureState.cleanup();
  }
});

test("--no-finalize preserves verified candidate stop-before-finalization behavior", async () => {
  const fixtureState = await fixture();
  try {
    let finalizations = 0;
    const code = await runBootstrapCli(["--cwd", fixtureState.root, "--issue", "85", "--no-finalize"], {
      runFinalizer: async () => {
        finalizations += 1;
        throw new Error("finalizer must not run");
      },
    }, async (options) => ({
      issueNumber: options.issueNumber,
      attempts: 1,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:00.000Z",
      disposition: "pass",
      branch: "agent/issue-85",
      worktree: ".worktrees/issue-85",
      revision: "r",
      baselineRevision: "b",
      candidate: { changedFiles: ["candidate.txt"] } as never,
      dependencySetup: { action: "not-required" },
      workerAttempts: [],
      checks: [],
      mechanicalPass: true,
      candidateReadyForReview: true,
      finalizationReady: true,
      implementationOutcome: "implemented",
      candidateHasDelta: true,
    }));
    assert.equal(code, 0);
    assert.equal(finalizations, 0);
  } finally {
    await fixtureState.cleanup();
  }
});

test("finalization block reports implementation and verification PASS while preserving candidate", async () => {
  const fixtureState = await fixture();
  const sourceStatusBefore = await git(process.cwd(), "status", "--porcelain");
  try {
    const code = await runBootstrapCli(["--cwd", fixtureState.root, "--issue", "85"], {
      runFinalizer: async () => {
        const error = new Error("required CI FAIL") as Error & { code: string };
        error.code = "CI_NOT_PASSING";
        throw error;
      },
    }, async (options) => ({
      issueNumber: options.issueNumber,
      attempts: 1,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:00.000Z",
      disposition: "pass",
      branch: "agent/issue-85",
      worktree: ".worktrees/issue-85",
      revision: "r",
      baselineRevision: "b",
      candidate: { changedFiles: ["candidate.txt"] } as never,
      dependencySetup: { action: "not-required" },
      workerAttempts: [],
      checks: [],
      mechanicalPass: true,
      candidateReadyForReview: true,
      finalizationReady: true,
      implementationOutcome: "implemented",
      candidateHasDelta: true,
    }));
    assert.equal(code, 2);

    const persisted = JSON.parse(await git(fixtureState.root, "show", "main:.pi-next/diagnostics/incidents/last.json"));
    assert.equal(persisted.failure.code, "CI_NOT_PASSING");
    assert.equal(persisted.source.issueNumber, 85);
    assert.equal(persisted.repository.root, fixtureState.root);
    assert.equal(await git(process.cwd(), "status", "--porcelain"), sourceStatusBefore);
  } finally {
    await fixtureState.cleanup();
  }
});

test("rejects implicit multi-issue progression", async () => {
  assert.equal(await main(["--queue", "75,76"]), 2);
});


test("reports bounded progress, activity, heartbeats and checks without leaking task content", async () => {
  const fixtureState = await fixture();
  try {
    const events: BootstrapProgressEvent[] = [];
    const factory: WorkerFactory = async ({ cwd }) => {
      let listener: ((event: unknown) => void) | undefined;
      return {
        model: { provider: "fake", id: "progress" },
        subscribe: (next) => {
          listener = next;
          return () => { if (listener === next) listener = undefined; };
        },
        prompt: async () => {
          listener?.({ type: "tool_execution_end", toolName: "read", args: { secret: "ghp_PROGRESS_SECRET" } });
          await writeFile(join(cwd, "progress-candidate.txt"), "candidate\n");
          await new Promise((resolve) => setTimeout(resolve, 30));
          listener?.({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
        },
        dispose: () => undefined,
      };
    };
    const dependencies = dependenciesFor(fixtureState.root, factory, () => 0, []);
    dependencies.reporter = (event) => events.push(event);
    dependencies.heartbeatMs = 5;
    dependencies.fetchIssue = async () => ({ ...issue(), body: "SECRET_TASK_BODY ghp_PROGRESS_SECRET" });

    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependencies,
    );

    assert.equal(report.disposition, "pass");
    assert.equal(events[0]?.phase, "preflight");
    assert.equal(events[0]?.state, "start");
    assert.ok(events.some((event) => event.phase === "worktree" && event.state === "ready"));
    assert.ok(events.some((event) => event.phase === "issue" && event.state === "ready"));
    assert.ok(events.some((event) => event.phase === "worker" && event.state === "activity" && event.tool === "read"));
    assert.ok(events.some((event) => event.phase === "worker" && event.state === "heartbeat"));
    assert.ok(events.some((event) => event.phase === "check" && event.state === "start" && event.command === "npm run typecheck"));
    assert.ok(events.some((event) => event.phase === "check" && event.state === "pass" && event.command === "npm test"));
    assert.equal(events.at(-1)?.phase, "terminal");
    assert.equal(events.at(-1)?.state, "pass");
    const rendered = JSON.stringify(events);
    assert.doesNotMatch(rendered, /SECRET_TASK_BODY|PROGRESS_SECRET/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("worker completes with passing checks and dirty candidate keeps normal implemented PASS semantics", async () => {
  const fixtureState = await fixture();
  try {
    const factory = fakeFactory([], async (_role, cwd) => {
      await writeFile(join(cwd, "implemented.txt"), "candidate\n");
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.equal(report.disposition, "pass");
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.candidateHasDelta, true);
    assert.equal(report.finalizationReady, true);
  } finally {
    await fixtureState.cleanup();
  }
});

test("existing empty canonical branch/worktree does not make an open no-op finalizable", async () => {
  const fixtureState = await fixture();
  try {
    await git(fixtureState.root, "branch", "agent/issue-75", "main");
    await mkdir(join(fixtureState.root, ".worktrees"), { recursive: true });
    await git(fixtureState.root, "worktree", "add", join(fixtureState.root, ".worktrees", "issue-75"), "agent/issue-75");
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    let finalizations = 0;
    const report = await runBootstrapLifecycle(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000, finalize: true },
      {
        ...dependenciesFor(fixtureState.root, fakeFactory(sessions, async () => undefined), () => 0, []),
        runFinalizer: async () => {
          finalizations += 1;
          throw new Error("empty branch must not finalize");
        },
      },
    );
    assert.equal(report.disposition, "no-change");
    assert.equal(report.implementationReport.finalizationReady, false);
    assert.equal(report.finalization, "SKIPPED");
    assert.equal(finalizations, 0);
  } finally {
    await fixtureState.cleanup();
  }
});

test("exact verified candidate proof resumes finalization without relaunching implementation", async () => {
  const fixtureState = await fixture();
  try {
    await git(fixtureState.root, "branch", "agent/issue-75", "main");
    await mkdir(join(fixtureState.root, ".worktrees"), { recursive: true });
    await git(fixtureState.root, "worktree", "add", join(fixtureState.root, ".worktrees", "issue-75"), "agent/issue-75");
    const candidateSha = await git(fixtureState.root, "rev-parse", "agent/issue-75");
    const commonDir = await git(fixtureState.root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    await mkdir(join(commonDir, "pi-next", "bootstrap-lifecycle"), { recursive: true });
    await writeFile(join(commonDir, "pi-next", "bootstrap-lifecycle", "issue-75.verified-candidate.json"), JSON.stringify({
      version: 1,
      issueNumber: 75,
      branch: "agent/issue-75",
      candidateSha,
      candidatePaths: ["previously-verified.txt"],
      verifiedAt: "2026-01-01T00:00:00.000Z",
      checks: ["npm run typecheck", "npm test"],
    }, null, 2) + "\n");
    let finalizations = 0;
    const report = await runBootstrapLifecycle(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000, finalize: true },
      {
        ...dependenciesFor(fixtureState.root, async () => { throw new Error("implementation worker must not relaunch"); }, () => 0, []),
        runFinalizer: async () => {
          finalizations += 1;
          return { ok: true, issueNumber: 75, branch: "agent/issue-75", candidateSha, merged: true, reachable: true, issueClosed: true, worktreeRemoved: true, localBranchRemoved: true, outcome: "finalized" };
        },
      },
    );
    assert.equal(report.finalization, "PASS");
    assert.equal(report.implementationReport.attempts, 0);
    assert.equal(finalizations, 1);
  } finally {
    await fixtureState.cleanup();
  }
});

test("worker no-op with passing checks launches one fresh bounded implementation retry, then exhausts cleanly", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const events: BootstrapProgressEvent[] = [];
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: true, timeoutMs: 5_000 },
      { ...dependenciesFor(fixtureState.root, fakeFactory(sessions, async () => undefined), () => 0, []), reporter: (event) => events.push(event) },
    );
    assert.equal(report.disposition, "no-change");
    assert.equal(report.implementationOutcome, "retry-exhausted");
    assert.equal(report.implementationAttemptCount, 2);
    assert.equal(report.implementationRetryBudgetExhausted, true);
    assert.match(report.implementationRetryEligibleReason ?? "", /zero candidate delta/i);
    assert.equal(report.candidateHasDelta, false);
    assert.equal(report.finalizationReady, false);
    assert.match(report.failureReason ?? "", /retry budget exhausted/i);
    assert.deepEqual(sessions.map((s) => s.role), ["implementation", "implementation-retry"]);
    assert.notEqual(sessions[0], sessions[1]);
    assert.match(sessions[1]!.prompt, /Previous implementation attempt returned completed but produced zero candidate changes/);
    assert.match(sessions[1]!.prompt, /zero-delta proof/);
    assert.doesNotMatch(sessions[1]!.prompt, /transcript|hidden reasoning/i);
    assert.match(events.at(-1)?.detail ?? "", /no candidate changes were produced/i);
  } finally {
    await fixtureState.cleanup();
  }
});

test("zero-delta implementation retry that produces a candidate verifies through the normal path", async () => {
  const fixtureState = await fixture();
  try {
    const sessions: Array<{ role: string; prompt: string; disposed: boolean; aborted: boolean }> = [];
    const factory = fakeFactory(sessions, async (role, cwd, prompt) => {
      if (role === "implementation-retry") {
        assert.match(prompt, /issue remains open and satisfaction was not mechanically proven/i);
        await writeFile(join(cwd, "retry-implemented.txt"), "implemented on retry\n");
      }
    });
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, factory, () => 0, []),
    );
    assert.equal(report.disposition, "pass");
    assert.equal(report.implementationOutcome, "implemented");
    assert.equal(report.implementationAttemptCount, 2);
    assert.equal(report.implementationRetryBudgetExhausted, false);
    assert.deepEqual(sessions.map((s) => s.role), ["implementation", "implementation-retry"]);
    assert.deepEqual(report.workerAttempts.map((attempt) => attempt.role), ["implementation", "implementation-retry"]);
    assert.ok(report.candidate.changedFiles.includes("retry-implemented.txt"));
  } finally {
    await fixtureState.cleanup();
  }
});

test("closed authoritative issue with zero delta is explicit already-satisfied and non-finalizable as a candidate", async () => {
  const fixtureState = await fixture();
  try {
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, timeoutMs: 5_000 },
      { ...dependenciesFor(fixtureState.root, fakeFactory([], async () => undefined), () => 0, []), fetchIssue: async () => ({ ...issue(), state: "CLOSED" }) },
    );
    assert.equal(report.disposition, "already-satisfied");
    assert.equal(report.implementationOutcome, "already-satisfied");
    assert.equal(report.finalizationReady, false);
    assert.equal(report.candidateReadyForReview, false);
    assert.match(report.noChangeReason ?? "", /CLOSED/);
  } finally {
    await fixtureState.cleanup();
  }
});

test("verify-only clean open issue reports coherent unproven no-change", async () => {
  const fixtureState = await fixture();
  try {
    const report = await runBootstrap(
      { issueNumber: 75, cwd: fixtureState.root, allowRepair: false, review: false, verifyOnly: true, timeoutMs: 5_000 },
      dependenciesFor(fixtureState.root, async () => { throw new Error("no worker"); }, () => 0, []),
    );
    assert.equal(report.disposition, "no-change");
    assert.equal(report.implementationOutcome, "unproven-no-change");
    assert.equal(report.finalizationReady, false);
  } finally {
    await fixtureState.cleanup();
  }
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
    const factory = fakeFactory([], async (role, cwd) => { if (role !== "review") await writeFile(join(cwd, "review-candidate.txt"), "candidate\n"); }, undefined, (role) => role === "review" ? { verdict: "pass" } : undefined);
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
    const factory = fakeFactory([], async (role, cwd) => { if (role !== "review") await writeFile(join(cwd, "review-blocking.txt"), "candidate\n"); }, undefined, (role) => role === "review" ? { verdict: "findings", findings: [{ severity: "blocking", path: "x.ts", summary: "wrong" }] } : undefined);
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
      dependenciesFor(fixtureState.root, fakeFactory([], async (role, cwd) => { if (role !== "review") await writeFile(join(cwd, "review-malformed.txt"), "candidate\n"); }), () => 0, []),
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
    const factory = fakeFactory([], async (role, cwd) => { if (role !== "review") await writeFile(join(cwd, "review-warning.txt"), "candidate\n"); }, undefined, (role) => role === "review" ? {
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

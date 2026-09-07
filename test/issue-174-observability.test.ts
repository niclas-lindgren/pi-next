import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPiNextLoop } from "../extensions/pi-next/loop.ts";
import { createPiLifecycleReporter, formatAutoTerminalSummary } from "../extensions/pi-next/auto-lifecycle-reporter.ts";
import { runLifecycleScheduler } from "../src/lifecycle/index.ts";
import { DEFAULT_PI_NEXT_CONFIG, type PiNextConfig } from "../src/coordination/config.ts";
import { analyzeWorkerContextBudget, formatContextBudgetSummary, loadContextFiles } from "../src/bootstrap/task-packet.ts";
import { runWorker } from "../src/bootstrap/worker-runner.ts";
import type { BootstrapReport, WorkerFactory, WorkerSession, WorkerStats } from "../src/bootstrap/types.ts";

const zero = "0".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-174-"));
  await mkdir(join(root, ".pi-next"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(join(root, "AGENTS.md"), "# Instructions\nRead docs/workflow.md and docs/testing.md.\n");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "workflow.md"), "workflow\n".repeat(200));
  await writeFile(join(root, "docs", "testing.md"), "testing\n".repeat(50));
  const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as PiNextConfig;
  config.authority.adapter = "memory";
  await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(config));
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function context(cwd: string, notifications: string[]): ExtensionCommandContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "issue-174-session" },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => undefined,
    },
    waitForIdle: async () => undefined,
  } as unknown as ExtensionCommandContext;
}

function report(issueNumber: number): BootstrapReport {
  return {
    issueNumber,
    attempts: 1,
    start: new Date(0).toISOString(),
    end: new Date(1).toISOString(),
    disposition: "pass",
    branch: `agent/issue-${issueNumber}`,
    worktree: `.worktrees/issue-${issueNumber}`,
    revision: zero,
    baselineRevision: zero,
    candidate: { headRevision: zero, baselineRevision: zero, originMainRevision: zero, mergeBaseRevision: zero, dirty: true, changedFiles: ["README.md"], committedChanges: false, uncommittedChanges: true, committedFiles: [], stagedFiles: [], unstagedFiles: ["README.md"], untrackedFiles: [], commitsAheadOfMergeBase: 0, commitsAheadOfOriginMain: 0, commitsBehindOriginMain: 0, behindOriginMain: false, divergedFromOriginMain: false },
    dependencySetup: { action: "not-required" },
    workerAttempts: [{ role: "implementation", disposition: "completed", durationMs: 10, toolCalls: 3, usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, total: 1500, cost: 0 }, terminalResultObserved: true }],
    checks: ["npm run typecheck", "npm test"].map((command) => ({ command, exitCode: 0, passed: true, durationMs: 1 })),
    mechanicalPass: true,
    candidateReadyForReview: true,
    finalizationReady: false,
    implementationOutcome: "implemented",
    candidateHasDelta: true,
  };
}

const fakeGitRunner = async (command: string, args: string[], options: { cwd: string }) => ({
  command,
  args,
  cwd: options.cwd,
  exitCode: 0,
  stdout: args.includes("--git-common-dir") ? `${options.cwd}/.git\n` : `${options.cwd}\n`,
  stderr: "",
  durationMs: 1,
});

test("/pi-next auto foreground START and IDLE summary do not depend on status/footer APIs", async () => {
  const f = await fixture();
  try {
    const notifications: string[] = [];
    const ctx = context(f.root, notifications);
    await runPiNextLoop("1", ctx);
    assert.match(notifications[0] || "", /Pi-next auto · START/);
    assert.ok(notifications.some((line) => /selecting work/.test(line)), notifications.join("\n"));
    assert.match(notifications.at(-1) || "", /Pi-next auto · IDLE · no eligible issues/);
  } finally {
    await f.cleanup();
  }
});

test("auto lifecycle reporter forwards scheduler, selection, claim, worker, verification, and terminal vocabulary", async () => {
  const f = await fixture();
  try {
    const lines: string[] = [];
    const ctx = context(f.root, lines);
    let selected = false;
    const result = await runLifecycleScheduler({
      cwd: f.root,
      entry: "auto",
      runId: "issue-174-reporter",
      allowRepair: true,
      review: false,
      finalize: true,
      policy: { maxIssues: 1, continueAfterIssueLocalFailure: true },
      discover: async () => selected ? undefined : (selected = true, { issueNumber: 1741 }),
      claim: async () => ({ release: async () => undefined }),
      requeryAuthority: async () => undefined,
      reporter: createPiLifecycleReporter(ctx),
    }, { runCommand: fakeGitRunner, reporter: createPiLifecycleReporter(ctx) }, async (options) => report(options.issueNumber));
    assert.equal(result.disposition, "budget-yield");
    assert.ok(lines.some((line) => /selecting work/.test(line)));
    assert.ok(lines.some((line) => /^selected #1741$/.test(line)));
    assert.ok(lines.some((line) => /#1741 · claim · START/.test(line)));
    assert.ok(lines.some((line) => /#1741 · preflight · START/.test(line)));
    assert.ok(lines.some((line) => /#1741 · worker · START/.test(line)));
    assert.ok(lines.some((line) => /#1741 · finalization · SKIPPED/.test(line)));
  } finally {
    await f.cleanup();
  }
});

test("scheduler terminal summaries distinguish idle, completed, blocked, cancelled, and budget-yield", () => {
  const base = { runId: "r", entry: "auto" as const, settled: 0, results: [] };
  assert.match(formatAutoTerminalSummary({ ...base, disposition: "idle" }, 5), /IDLE/);
  assert.match(formatAutoTerminalSummary({ ...base, disposition: "completed", settled: 2 }, 5), /COMPLETED · 2\/5 settled/);
  assert.match(formatAutoTerminalSummary({ ...base, disposition: "cancelled", settled: 1 }, 5), /CANCELLED/);
  assert.match(formatAutoTerminalSummary({ ...base, disposition: "budget-yield", settled: 3 }, 5), /BUDGET YIELD · 3\/5 settled/);
  const latest = {
    issueNumber: 7,
    finalization: "BLOCKED" as const,
    disposition: "finalization-blocked" as const,
  } as Parameters<typeof formatAutoTerminalSummary>[0]["latest"];
  assert.match(formatAutoTerminalSummary({ ...base, disposition: "blocked", latest }, 5), /#7 finalization blocked; candidate preserved/);
});

test("worker context budget report names dominant repository docs and comments without a model call", async () => {
  const f = await fixture();
  try {
    const issue = { number: 1742, title: "Context", body: "Use docs/workflow.md", comments: [{ body: "large comment ".repeat(500), author: { login: "tester" } }] };
    const files = await loadContextFiles(f.root, issue);
    const budget = analyzeWorkerContextBudget(issue, f.root, files, "implementation");
    assert.ok(budget.estimatedTokens > 0);
    assert.ok(budget.contributions.some((entry) => entry.id === "docs/workflow.md"));
    const summary = formatContextBudgetSummary(budget);
    assert.match(summary, /context budget/);
    assert.match(summary, /docs\/workflow\.md|issue comments/);
  } finally {
    await f.cleanup();
  }
});

test("active worker token runaway emits usage and trips the hard budget despite continued tool activity", async () => {
  let stats: WorkerStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const session: WorkerSession = {
    subscribe: (listener) => {
      setImmediate(() => {
        stats = { input: 60000, output: 1000, cacheRead: 29000, cacheWrite: 0, total: 90000, cost: 0 };
        listener({ type: "tool_execution_end", toolName: "safe_bash" });
      });
      return () => undefined;
    },
    dispose: () => undefined,
    getSessionStats: () => ({ ...stats, tokens: stats, toolCalls: 34 }),
    prompt: async () => new Promise<void>(() => undefined),
  };
  const factory: WorkerFactory = async () => session;
  const events: string[] = [];
  const reports: BootstrapReport["workerAttempts"] = [];
  const result = await runWorker(factory, "implementation", "prompt", process.cwd(), 30_000, reports, 174, (event) => events.push(`${event.state}:${event.detail || ""}:${event.usage?.total ?? 0}`), 1);
  assert.equal(result.disposition, "cancelled");
  assert.match(result.reason || "", /token budget exhausted/);
  assert.ok(events.some((line) => /90000/.test(line)), events.join("\n"));
});

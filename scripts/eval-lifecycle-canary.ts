#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { WorkerAdapter, WorkerEvent, WorkerTerminalResult } from "../src/coordination/worker-adapter.ts";
import type { WorkerFactory, WorkerSession, WorkerStats } from "../src/bootstrap/types.ts";
import { runSingleIssueLifecycle } from "../src/lifecycle/index.ts";
import { PiWorkerAdapter } from "../src/evaluation/pi-worker-adapter.ts";
import { ScriptedWorkerAdapter, type ScriptedWorkerScript } from "../src/evaluation/scripted-worker-adapter.ts";
import { gradeWorkerCanaryFixture, workerCanaryFixtures, type WorkerCanaryFixture, type CanaryAggregateReport, type CanaryRunResult } from "../src/evaluation/worker-canaries.ts";
import { piNextRuntimeIdentity } from "../src/version.ts";

const exec = promisify(execFile);

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const solutions = new Map<string, ScriptedWorkerScript>([
  ["localized-bug-fix", { writes: [{ path: "src/math.ts", content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n" }] }],
  ["behavior-change-with-tests", { writes: [{ path: "src/clamp.ts", content: "export function clamp(value: number, min: number, max: number): number {\n  const lower = Math.min(min, max);\n  const upper = Math.max(min, max);\n  return Math.min(upper, Math.max(lower, value));\n}\n" }] }],
  ["small-multi-file-refactor", { writes: [
    { path: "src/punctuation.ts", content: "export const punctuation = '!';\n" },
    { path: "src/email.ts", content: "import { punctuation } from './punctuation';\nexport function emailGreeting(name: string): string {\n  return `Hello, ${name}${punctuation}`;\n}\n" },
    { path: "src/slack.ts", content: "import { punctuation } from './punctuation';\nexport function slackGreeting(name: string): string {\n  return `Hey ${name}${punctuation}`;\n}\n" },
  ] }],
  ["inspection-targeted-change", { writes: [{ path: "src/config.ts", content: "export const DEFAULT_TIMEOUT_MS = 45000;\n" }] }],
  ["failure-diagnosis-repair", { writes: [{ path: "src/retry.ts", content: "export function parseRetryAfterSeconds(header: string, nowMs = Date.now()): number {\n  const seconds = Number(header);\n  if (Number.isFinite(seconds)) return seconds;\n  const dateMs = Date.parse(header);\n  return Number.isFinite(dateMs) ? Math.max(0, Math.ceil((dateMs - nowMs) / 1000)) : 0;\n}\n" }] }],
  ["repository-contract-generated-file", { writes: [
    { path: "src/schema.ts", content: "export const UserSchema = {\n  id: 'string',\n  email: 'string',\n  displayName: 'string',\n};\n" },
    { path: "generated/schema.txt", content: "id:string\nemail:string\ndisplayName:string\n" },
  ] }],
]);

function patchPackage(content: string): string {
  const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
  parsed.scripts = { ...(parsed.scripts ?? {}), typecheck: parsed.scripts?.typecheck ?? "node -e \"\"" };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function writeFixture(cwd: string, fixture: WorkerCanaryFixture): Promise<void> {
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "# Canary instructions\n\nUse only this disposable repository.\n", "utf8");
  await writeFile(join(cwd, "docs", "EVALUATION_AND_RELIABILITY.md"), "# Canary evaluation\n\nHidden grader assertions decide PASS.\n", "utf8");
  for (const file of fixture.files) {
    const path = join(cwd, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.path === "package.json" ? patchPackage(file.content) : file.content, "utf8");
  }
  await exec("git", ["init", "--initial-branch=main", "--quiet"], { cwd });
  await exec("git", ["config", "user.email", "lifecycle-canary@example.invalid"], { cwd });
  await exec("git", ["config", "user.name", "pi-next lifecycle canary"], { cwd });
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "initial lifecycle canary fixture"], { cwd });
  const remote = `${cwd}.origin.git`;
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["remote", "add", "origin", remote], { cwd });
  await exec("git", ["push", "--quiet", "-u", "origin", "main"], { cwd });
}

class AdapterSession implements WorkerSession {
  private listeners: Array<(event: unknown) => void> = [];
  private result: WorkerTerminalResult | undefined;
  get model() { return { provider: "worker-adapter", id: this.adapter.id }; }
  constructor(private readonly adapter: WorkerAdapter, private readonly cwd: string, private readonly issueNumber: number, private readonly runId: string, private readonly signal: AbortSignal) {}
  subscribe(listener: (event: unknown) => void): () => void { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter((entry) => entry !== listener); }; }
  dispose(): void { this.listeners = []; }
  async prompt(text: string): Promise<void> {
    const emit = (event: WorkerEvent) => { if (event.type === "activity") this.listeners.forEach((l) => l({ type: "tool_execution_end", toolName: event.kind })); };
    this.result = await this.adapter.run({ cwd: this.cwd, prompt: text, issueNumber: this.issueNumber, runId: this.runId, phase: "implementation", dispatch: { version: 1, role: "implementation", capabilities: { kind: "mutable-owner" } } as never }, this.signal, emit);
    const failure = this.result.failure;
    this.listeners.forEach((listener) => listener({ type: "done", message: { role: "assistant", content: this.result?.output ?? "", stopReason: this.result?.ok ? "stop" : "error", errorCode: failure?.code, errorMessage: failure?.diagnosticExcerpt } }));
  }
  getSessionStats(): Partial<WorkerStats> & { tokens?: Partial<WorkerStats>; toolCalls?: number } {
    const usage = this.result?.telemetry.usage;
    return { tokens: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens } : undefined, cost: usage?.cost, toolCalls: this.result?.telemetry.activity?.toolCalls ?? 0 };
  }
}

async function runFixture(adapter: WorkerAdapter, fixture: WorkerCanaryFixture, index: number): Promise<CanaryRunResult> {
  const cwd = await mkdtemp(join(tmpdir(), `pi-next-lifecycle-canary-${fixture.id}-`));
  const started = Date.now();
  try {
    await writeFixture(cwd, fixture);
    const issueNumber = 8100 + index;
    const runId = `lifecycle-canary-${fixture.id}`;
    const factory: WorkerFactory = async (input) => new AdapterSession(adapter, input.cwd, issueNumber, runId, input.signal);
    const lifecycle = await runSingleIssueLifecycle({ cwd, workItem: { issueNumber }, entry: "explicit", runId, allowRepair: true, review: false, finalize: false, timeoutMs: 60_000 }, {
      createWorker: factory,
      fetchIssue: async () => ({ number: issueNumber, title: fixture.category, body: fixture.task, state: "OPEN", comments: [] }),
    });
    const worktree = resolve(cwd, lifecycle.implementationReport.worktree);
    const graderFailures = await gradeWorkerCanaryFixture(worktree, fixture);
    return {
      fixtureId: fixture.id,
      category: fixture.category,
      passed: lifecycle.disposition === "pass" && graderFailures.length === 0,
      workerOk: lifecycle.implementationReport.workerAttempts.at(-1)?.disposition === "completed",
      wallTimeMs: Date.now() - started,
      graderFailures,
      adapter: { id: adapter.id, version: adapter.version, model: lifecycle.implementationReport.workerAttempts.at(-1)?.model },
      harness: { name: "pi-next-worker-eval", version: piNextRuntimeIdentity().version, fixtureFormatVersion: 1 },
      usage: lifecycle.implementationReport.workerAttempts.at(-1)?.usage ? { input: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.input, output: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.output, cacheRead: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.cacheRead, cacheWrite: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.cacheWrite, totalTokens: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.total, cost: lifecycle.implementationReport.workerAttempts.at(-1)!.usage!.cost } : undefined,
      turns: undefined,
      toolCalls: lifecycle.implementationReport.workerAttempts.reduce((sum, attempt) => sum + attempt.toolCalls, 0),
      retries: Math.max(0, lifecycle.implementationReport.workerAttempts.length - 1),
      humanInterventionRequired: false,
    };
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(`${cwd}.origin.git`, { recursive: true, force: true }); }
}

const adapterName = argValue("--adapter") ?? "pi";
const smoke = process.argv.includes("--smoke");
const output = argValue("--output");
const allowLlm = process.env.PI_NEXT_EVAL_ALLOW_LLM === "1" || process.env.PI_NEXT_WORKER_EVAL_ALLOW_LLM === "1";
if (adapterName === "pi" && !allowLlm) {
  console.error("Refusing lifecycle canary without PI_NEXT_EVAL_ALLOW_LLM=1");
  process.exit(2);
}
if (adapterName !== "pi" && adapterName !== "scripted") {
  console.error(`Unknown lifecycle canary adapter: ${adapterName}`);
  process.exit(2);
}
const fixtures = smoke ? workerCanaryFixtures.slice(0, 1) : workerCanaryFixtures;
const adapter: WorkerAdapter = adapterName === "pi" ? new PiWorkerAdapter() : new ScriptedWorkerAdapter(fixtures.map((fixture) => ({ name: fixture.id, behavior: "success", ...(solutions.get(fixture.id) ?? {}) })));
const results = [];
for (let index = 0; index < fixtures.length; index += 1) results.push(await runFixture(adapter, fixtures[index]!, index + 1));
const passed = results.filter((result) => result.passed).length;
const totalTokens = results.some((r) => r.usage) ? results.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0) : undefined;
const report: CanaryAggregateReport & { lifecycleBoundary: string; retryPolicy: string } = {
  generatedAt: new Date().toISOString(), adapter: { id: adapter.id, version: adapter.version }, harness: { name: "pi-next-worker-eval", version: piNextRuntimeIdentity().version, fixtureFormatVersion: 1 }, fixtureCount: results.length, passed, passRate: results.length ? passed / results.length : 0, totalWallTimeMs: results.reduce((sum, r) => sum + r.wallTimeMs, 0), totalToolCalls: results.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0), totalRetries: results.reduce((sum, r) => sum + r.retries, 0), humanInterventionRequired: false, totalEstimatedPromptTokens: 0, totalEstimatedSkillTokens: 0, totalTokens, tokensPerVerifiedCompletion: totalTokens !== undefined && passed ? totalTokens / passed : undefined, results, lifecycleBoundary: "runSingleIssueLifecycle -> bootstrap supervisor -> WorkerAdapter", retryPolicy: "credentialed canary is explicit; compare reports to docs/evaluation/pi-worker-baseline.initial.json with conservative non-flaky review",
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, json, "utf8"); }
console.log(json);
if (passed !== results.length) process.exitCode = 1;

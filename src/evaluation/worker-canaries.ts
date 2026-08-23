import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { WorkerAdapter, WorkerTask, WorkerTerminalResult } from "../coordination/worker-adapter.ts";
import { piNextRuntimeIdentity } from "../version.ts";
import { buildContextPacket, type BuiltContextPacket, type ContextStrategyId } from "./context-strategies.ts";

const execFileAsync = promisify(execFile);

export interface WorkerCanaryFile { path: string; content: string }
export interface WorkerCanaryFixture {
  id: string;
  category: string;
  task: string;
  files: readonly WorkerCanaryFile[];
  hiddenAssertions: readonly GraderAssertion[];
}

export type GraderAssertion =
  | { type: "command"; command: string; args?: readonly string[]; timeoutMs?: number }
  | { type: "fileContains"; path: string; text: string }
  | { type: "fileNotContains"; path: string; text: string }
  | { type: "generatedMatches"; source: string; generated: string; prefix: string };

export interface CanaryRunResult {
  fixtureId: string;
  category: string;
  passed: boolean;
  workerOk: boolean;
  wallTimeMs: number;
  graderFailures: string[];
  adapter: { id: string; version: string; model?: string };
  harness: { name: "pi-next-worker-eval"; version: string; fixtureFormatVersion: number };
  usage?: WorkerTerminalResult["telemetry"]["usage"];
  context?: Pick<BuiltContextPacket, "strategy" | "estimatedPromptTokens" | "repoMap" | "skills">;
  turns?: number;
  toolCalls?: number;
  retries: number;
  humanInterventionRequired: boolean;
}

export interface CanaryAggregateReport {
  generatedAt: string;
  adapter: { id: string; version: string };
  harness: { name: "pi-next-worker-eval"; version: string; fixtureFormatVersion: number };
  fixtureCount: number;
  passed: number;
  passRate: number;
  totalWallTimeMs: number;
  totalTurns?: number;
  totalToolCalls?: number;
  totalRetries: number;
  humanInterventionRequired: boolean;
  totalTokens?: number;
  totalCost?: number;
  totalEstimatedPromptTokens: number;
  totalEstimatedSkillTokens: number;
  tokensPerVerifiedCompletion?: number;
  costPerVerifiedCompletion?: number;
  results: CanaryRunResult[];
}

const testRunner = `import assert from 'node:assert/strict';\nimport { readFileSync, existsSync } from 'node:fs';\nfunction src(p){return readFileSync(p,'utf8')}\nfunction has(p,t){assert.ok(src(p).includes(t), p+' missing '+t)}\n`;

export const WORKER_CANARY_FIXTURE_FORMAT_VERSION = 1;

export const workerCanaryFixtures: readonly WorkerCanaryFixture[] = [
  {
    id: "localized-bug-fix",
    category: "localized bug fix",
    task: "Fix the localized arithmetic bug in src/math.ts. Keep the public function name add and make npm test pass.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs" } }, null, 2) },
      { path: "src/math.ts", content: "export function add(a: number, b: number): number {\n  return a - b;\n}\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}const s=src('src/math.ts');has('src/math.ts','export function add');assert.ok(!s.includes('return a - b'),'add must not subtract');assert.ok(/return\\s+a\\s*\\+\\s*b/.test(s),'add should return a + b');\n` },
    ],
    hiddenAssertions: [{ type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 }],
  },
  {
    id: "behavior-change-with-tests",
    category: "behavior change with tests",
    task: "Change src/clamp.ts so clamp(value, min, max) supports reversed bounds by treating the smaller bound as min and larger as max. Preserve normal behavior and update tests if needed.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs" } }, null, 2) },
      { path: "src/clamp.ts", content: "export function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}const s=src('src/clamp.ts');assert.ok(/Math\\.min/.test(s)&&/Math\\.max/.test(s));assert.ok(/minBound|lower|lo|low|small|Math\\.min\\(min,\\s*max\\)/.test(s),'hidden: reversed bounds must be normalized');\n` },
    ],
    hiddenAssertions: [{ type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 }],
  },
  {
    id: "small-multi-file-refactor",
    category: "small multi-file refactor",
    task: "Refactor greeting punctuation into a shared helper in src/punctuation.ts. Both src/email.ts and src/slack.ts should use the helper instead of duplicating the exclamation mark literal.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs" } }, null, 2) },
      { path: "src/email.ts", content: "export function emailGreeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n" },
      { path: "src/slack.ts", content: "export function slackGreeting(name: string): string {\n  return `Hey ${name}!`;\n}\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}assert.ok(existsSync('src/punctuation.ts'),'shared helper file required');has('src/email.ts','punctuation');has('src/slack.ts','punctuation');assert.equal((src('src/email.ts').match(/!/g)||[]).length,0);assert.equal((src('src/slack.ts').match(/!/g)||[]).length,0);has('src/punctuation.ts','!');\n` },
    ],
    hiddenAssertions: [{ type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 }],
  },
  {
    id: "inspection-targeted-change",
    category: "repository inspection + targeted change",
    task: "Inspect docs/OPERATIONS.md and update src/config.ts so DEFAULT_TIMEOUT_MS follows the documented timeout. Do not change the documentation.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs" } }, null, 2) },
      { path: "docs/OPERATIONS.md", content: "# Operations\n\nDefault worker timeout: 45000 ms.\n" },
      { path: "src/config.ts", content: "export const DEFAULT_TIMEOUT_MS = 30000;\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}has('docs/OPERATIONS.md','45000 ms');has('src/config.ts','45000');assert.ok(!src('docs/OPERATIONS.md').includes('30000'));\n` },
    ],
    hiddenAssertions: [{ type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 }],
  },
  {
    id: "failure-diagnosis-repair",
    category: "failure diagnosis/repair",
    task: "npm test fails because parseRetryAfterSeconds mishandles Retry-After date strings. Repair src/retry.ts so numeric seconds and future HTTP dates both work.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs" } }, null, 2) },
      { path: "src/retry.ts", content: "export function parseRetryAfterSeconds(header: string, nowMs = Date.now()): number {\n  const seconds = Number(header);\n  return Number.isFinite(seconds) ? seconds : 0;\n}\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}const s=src('src/retry.ts');assert.ok(/Date\\.parse|new Date/.test(s),'date Retry-After must be parsed');assert.ok(/nowMs/.test(s));assert.ok(!s.includes('? seconds : 0'),'invalid dates only should be zero');\n` },
    ],
    hiddenAssertions: [{ type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 }],
  },
  {
    id: "repository-contract-generated-file",
    category: "repository contract adherence",
    task: "Follow the repository contract: edit src/schema.ts and run npm run generate so generated/schema.txt stays derived. Do not hand-edit generated/schema.txt only. Add the new field displayName: string to UserSchema.",
    files: [
      { path: "package.json", content: JSON.stringify({ type: "module", scripts: { test: "node test/run-tests.mjs", generate: "node scripts/generate.mjs" } }, null, 2) },
      { path: "src/schema.ts", content: "export const UserSchema = {\n  id: 'string',\n  email: 'string',\n};\n" },
      { path: "generated/schema.txt", content: "id:string\nemail:string\n" },
      { path: "scripts/generate.mjs", content: "import { readFileSync, writeFileSync } from 'node:fs';\nconst s=readFileSync('src/schema.ts','utf8');\nconst fields=[...s.matchAll(/(\\w+): '([^']+)'/g)].map(m=>`${m[1]}:${m[2]}`).join('\\n')+'\\n';\nwriteFileSync('generated/schema.txt',fields);\n" },
      { path: "test/run-tests.mjs", content: `${testRunner}has('src/schema.ts','displayName');has('generated/schema.txt','displayName:string');\n` },
    ],
    hiddenAssertions: [
      { type: "command", command: "npm", args: ["test"], timeoutMs: 20_000 },
      { type: "generatedMatches", source: "src/schema.ts", generated: "generated/schema.txt", prefix: "" },
    ],
  },
];

async function writeFixture(cwd: string, fixture: WorkerCanaryFixture): Promise<void> {
  for (const file of fixture.files) {
    const path = join(cwd, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
  await execFileAsync("git", ["init", "--quiet"], { cwd });
  await execFileAsync("git", ["config", "user.email", "eval@example.invalid"], { cwd });
  await execFileAsync("git", ["config", "user.name", "pi-next eval"], { cwd });
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial canary fixture"], { cwd });
}

async function grade(cwd: string, fixture: WorkerCanaryFixture): Promise<string[]> {
  const failures: string[] = [];
  for (const assertion of fixture.hiddenAssertions) {
    try {
      if (assertion.type === "command") {
        await execFileAsync(assertion.command, [...(assertion.args ?? [])], { cwd, timeout: assertion.timeoutMs ?? 30_000, encoding: "utf8" });
      } else if (assertion.type === "fileContains") {
        const content = await readFile(join(cwd, assertion.path), "utf8");
        if (!content.includes(assertion.text)) failures.push(`${assertion.path} does not contain ${assertion.text}`);
      } else if (assertion.type === "fileNotContains") {
        const content = await readFile(join(cwd, assertion.path), "utf8");
        if (content.includes(assertion.text)) failures.push(`${assertion.path} unexpectedly contains ${assertion.text}`);
      } else {
        const source = await readFile(join(cwd, assertion.source), "utf8");
        const generated = await readFile(join(cwd, assertion.generated), "utf8");
        const expected = [...source.matchAll(/(\w+): '([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`).join("\n") + "\n";
        if (generated !== `${assertion.prefix}${expected}`) failures.push(`${assertion.generated} is not generated from ${assertion.source}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message.slice(-1_000) : String(error));
    }
  }
  return failures;
}

export interface CanaryRunOptions { contextStrategy?: ContextStrategyId }

export async function runWorkerCanaryFixture(adapter: WorkerAdapter, fixture: WorkerCanaryFixture, options: CanaryRunOptions = {}): Promise<CanaryRunResult> {
  const cwd = await mkdtemp(join(tmpdir(), `pi-next-canary-${fixture.id}-`));
  const started = Date.now();
  try {
    await writeFixture(cwd, fixture);
    const context = await buildContextPacket({ cwd, task: fixture.task, strategy: options.contextStrategy ?? "default", role: "implementation" });
    const task: WorkerTask = { cwd, prompt: context.prompt, phase: "implementation", runId: `eval-${fixture.id}`, dispatch: { version: 1, role: "implementation", capabilities: { kind: "mutable-owner" }, contextStrategy: context.strategy, selectedSkills: context.skills.selected, loadedSkills: context.skills.loaded } as any };
    const worker = await adapter.run(task, new AbortController().signal);
    const graderFailures = await grade(cwd, fixture);
    const wallTimeMs = Date.now() - started;
    return {
      fixtureId: fixture.id,
      category: fixture.category,
      passed: graderFailures.length === 0,
      workerOk: worker.ok,
      wallTimeMs,
      graderFailures,
      adapter: { id: adapter.id, version: adapter.version, model: worker.telemetry.model },
      harness: { name: "pi-next-worker-eval", version: piNextRuntimeIdentity().version, fixtureFormatVersion: WORKER_CANARY_FIXTURE_FORMAT_VERSION },
      usage: worker.telemetry.usage,
      context: { strategy: context.strategy, estimatedPromptTokens: context.estimatedPromptTokens, repoMap: context.repoMap, skills: context.skills },
      turns: worker.telemetry.activity?.modelRounds,
      toolCalls: worker.telemetry.activity?.toolCalls,
      retries: 0,
      humanInterventionRequired: false,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function runWorkerCanaryCorpus(adapter: WorkerAdapter, fixtures: readonly WorkerCanaryFixture[] = workerCanaryFixtures, options: CanaryRunOptions = {}): Promise<CanaryAggregateReport> {
  const results: CanaryRunResult[] = [];
  for (const fixture of fixtures) results.push(await runWorkerCanaryFixture(adapter, fixture, options));
  const passed = results.filter((result) => result.passed).length;
  const totalTokens = results.some((r) => r.usage) ? results.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0) : undefined;
  const totalCost = results.some((r) => r.usage) ? results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0) : undefined;
  const totalTurns = results.some((r) => r.turns !== undefined) ? results.reduce((sum, r) => sum + (r.turns ?? 0), 0) : undefined;
  const totalToolCalls = results.some((r) => r.toolCalls !== undefined) ? results.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0) : undefined;
  const totalEstimatedPromptTokens = results.reduce((sum, r) => sum + (r.context?.estimatedPromptTokens ?? 0), 0);
  const totalEstimatedSkillTokens = results.reduce((sum, r) => sum + (r.context?.skills.totalEstimatedTokens ?? 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    adapter: { id: adapter.id, version: adapter.version },
    harness: { name: "pi-next-worker-eval", version: piNextRuntimeIdentity().version, fixtureFormatVersion: WORKER_CANARY_FIXTURE_FORMAT_VERSION },
    fixtureCount: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    totalWallTimeMs: results.reduce((sum, result) => sum + result.wallTimeMs, 0),
    totalTurns,
    totalToolCalls,
    totalRetries: results.reduce((sum, result) => sum + result.retries, 0),
    humanInterventionRequired: results.some((result) => result.humanInterventionRequired),
    totalEstimatedPromptTokens,
    totalEstimatedSkillTokens,
    totalTokens,
    totalCost,
    tokensPerVerifiedCompletion: totalTokens !== undefined && passed > 0 ? totalTokens / passed : undefined,
    costPerVerifiedCompletion: totalCost !== undefined && passed > 0 ? totalCost / passed : undefined,
    results,
  };
}

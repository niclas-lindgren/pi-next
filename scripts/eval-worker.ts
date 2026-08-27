#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PiWorkerAdapter } from "../src/evaluation/pi-worker-adapter.ts";
import { CodexCliWorkerAdapter } from "../src/evaluation/codex-cli-worker-adapter.ts";
import { type ContextStrategyId } from "../src/evaluation/context-strategies.ts";
import { runWorkerCanaryCorpus, workerCanaryFixtures } from "../src/evaluation/worker-canaries.ts";
import { ScriptedWorkerAdapter } from "../src/evaluation/scripted-worker-adapter.ts";
import { formatCodexProbe, probeCodexUsageLimit } from "./codex-limit.ts";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterName = argValue("--adapter") ?? "pi";
const smoke = process.argv.includes("--smoke");
const output = argValue("--output");
const model = argValue("--model");
const codexCommand = argValue("--codex-command");
const codexVersion = argValue("--codex-version") ?? process.env.PI_NEXT_CODEX_CLI_VERSION;
const contextStrategy = (argValue("--context-strategy") ?? "default") as ContextStrategyId;
const knownContextStrategies = new Set<string>(["default", "minimal", "no-controller-context", "repo-map", "selective-skills", "resolver", "expanded-skill-registry", "verification-discipline"]);
const allowLlm = process.env.PI_NEXT_EVAL_ALLOW_LLM === "1" || process.env.PI_NEXT_WORKER_EVAL_ALLOW_LLM === "1";

if (!knownContextStrategies.has(contextStrategy)) {
  console.error(`Unknown context strategy: ${contextStrategy}`);
  process.exit(2);
}

if ((adapterName === "pi" || adapterName === "codex" || adapterName === "codex-cli") && !allowLlm) {
  console.error(`Refusing to run real ${adapterName} worker eval without PI_NEXT_EVAL_ALLOW_LLM=1. Normal npm test remains zero-LLM.`);
  process.exit(2);
}

const fixtures = smoke ? workerCanaryFixtures.slice(0, 1) : workerCanaryFixtures;
const scriptedSolutions = new Map<string, any>([
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
const adapter = adapterName === "pi"
  ? new PiWorkerAdapter({ model })
  : adapterName === "codex" || adapterName === "codex-cli"
    ? new CodexCliWorkerAdapter({ command: codexCommand, model, harnessVersion: codexVersion })
    : adapterName === "scripted"
      ? new ScriptedWorkerAdapter(fixtures.map((fixture) => ({ name: fixture.id, behavior: "success" as const, ...(scriptedSolutions.get(fixture.id) ?? {}) })))
      : undefined;

if (!adapter) {
  console.error(`Unknown worker eval adapter: ${adapterName}`);
  process.exit(2);
}

const report = await runWorkerCanaryCorpus(adapter, fixtures, { contextStrategy });
// When the provider answered with a usage-limit error, probe the Codex
// endpoint deterministically and print the exact reset windows so the run's
// operator knows when the credentialed comparison can be retried (#172).
const usageLimited = report.results.some((result) => /usage limit|usage_limit/i.test(result.failureSummary ?? ""));
if (usageLimited) {
  const probe = await probeCodexUsageLimit();
  console.error(formatCodexProbe(probe));
}
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf8");
}
console.log(json);
if (report.passed !== report.fixtureCount) process.exitCode = 1;

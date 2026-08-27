import { spawn } from "node:child_process";

import {
  WORKER_ADAPTER_VERSION,
  type WorkerAdapter,
  type WorkerEventSink,
  type WorkerTask,
  type WorkerTerminalResult,
  type WorkerUsageTelemetry,
} from "../coordination/worker-adapter.ts";

export type CodexCliSandboxMode = "read-only" | "workspace-write";
export type CodexCliApprovalPolicy = "never";

export interface CodexCliWorkerAdapterOptions {
  /** Executable to launch. Defaults to the `codex` CLI on PATH. */
  command?: string;
  /** Prefix arguments before adapter-controlled Codex arguments. Defaults to [`exec`]. */
  baseArgs?: readonly string[];
  /** Model identifier passed to Codex CLI. */
  model?: string;
  /** Adapter-visible harness version, usually captured from `codex --version` by the operator. */
  harnessVersion?: string;
  /** Extra arguments appended before the task prompt. Must not change cwd/sandbox/approval semantics. */
  extraArgs?: readonly string[];
  /** Mutable-task sandbox. Read-only tasks always use `read-only`. */
  sandbox?: CodexCliSandboxMode;
  /** Unattended evals must not pause for human approval. */
  approvalPolicy?: CodexCliApprovalPolicy;
  /** Request Codex JSONL events when supported by the CLI. Defaults to true. */
  json?: boolean;
  /** Bounded retained combined stdout/stderr. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodexCliInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16_000;
const SENSITIVE_ENV_PREFIXES = ["GITHUB_", "GH_", "GITLAB_", "BITBUCKET_"];
const SENSITIVE_ENV_KEYS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
]);

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(-maxBytes);
}

function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_KEYS.has(key)) continue;
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = env.NO_COLOR ?? "1";
  return env;
}

function assertSafeOptions(options: CodexCliWorkerAdapterOptions): void {
  if (options.approvalPolicy !== undefined && options.approvalPolicy !== "never") {
    throw new Error("CodexCliWorkerAdapter only supports unattended approvalPolicy=never");
  }
  if ((options.sandbox as string | undefined) === "danger-full-access") {
    throw new Error("CodexCliWorkerAdapter refuses Codex danger-full-access sandbox");
  }
  const forbiddenExtra = new Set(["--cd", "-C", "--sandbox", "--ask-for-approval", "--approval-policy", "--dangerously-bypass-approvals-and-sandbox"]);
  for (const [label, args] of [["baseArgs", options.baseArgs], ["extraArgs", options.extraArgs]] as const) {
    for (const arg of args ?? []) {
      const [flag] = arg.split("=", 1);
      if (forbiddenExtra.has(flag)) throw new Error(`CodexCliWorkerAdapter ${label} cannot override ${flag}`);
    }
  }
}

export function buildCodexCliInvocation(task: WorkerTask, options: CodexCliWorkerAdapterOptions = {}): CodexCliInvocation {
  assertSafeOptions(options);
  const command = options.command ?? process.env.PI_NEXT_CODEX_CLI_COMMAND ?? "codex";
  const baseArgs = [...(options.baseArgs ?? ["exec"])];
  const model = options.model ?? process.env.PI_NEXT_CODEX_MODEL ?? process.env.PI_NEXT_EVAL_MODEL;
  const sandbox: CodexCliSandboxMode = task.readOnly ? "read-only" : (options.sandbox ?? "workspace-write");
  const args = [
    ...baseArgs,
    ...(model?.trim() ? ["--model", model.trim()] : []),
    "--sandbox", sandbox,
    "--ask-for-approval", options.approvalPolicy ?? "never",
    "--cd", task.cwd,
    ...(options.json === false ? [] : ["--json"]),
    ...(options.extraArgs ?? []),
    task.prompt,
  ];
  return { command, args, env: sanitizedEnv(options.env) };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberField(object: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringField(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export interface ParsedCodexOutput {
  usage?: WorkerUsageTelemetry;
  model?: string;
  modelRounds?: number;
  toolCalls?: number;
  toolResults?: number;
  eventKinds: string[];
}

function usageFromObject(object: Record<string, unknown>): WorkerUsageTelemetry | undefined {
  const usageContainer = asObject(object.usage) ?? asObject(object.token_usage) ?? asObject(object.tokens) ?? object;
  const input = numberField(usageContainer, ["input", "input_tokens", "prompt_tokens"]);
  const output = numberField(usageContainer, ["output", "output_tokens", "completion_tokens"]);
  const cacheRead = numberField(usageContainer, ["cacheRead", "cache_read", "cached_input_tokens", "cached_tokens"]);
  const cacheWrite = numberField(usageContainer, ["cacheWrite", "cache_write", "cache_creation_input_tokens"]);
  const totalTokens = numberField(usageContainer, ["totalTokens", "total_tokens", "total"]);
  const cost = numberField(usageContainer, ["cost", "cost_usd", "estimated_cost_usd"]);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && totalTokens === undefined && cost === undefined) return undefined;
  const normalizedInput = input ?? 0;
  const normalizedOutput = output ?? 0;
  const normalizedCacheRead = cacheRead ?? 0;
  const normalizedCacheWrite = cacheWrite ?? 0;
  return {
    input: normalizedInput,
    output: normalizedOutput,
    cacheRead: normalizedCacheRead,
    cacheWrite: normalizedCacheWrite,
    totalTokens: totalTokens ?? normalizedInput + normalizedOutput + normalizedCacheRead + normalizedCacheWrite,
    cost: cost ?? 0,
  };
}

function visitJson(value: unknown, visitor: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  const object = asObject(value);
  if (!object) return;
  visitor(object);
  for (const child of Object.values(object)) visitJson(child, visitor);
}

export function parseCodexCliJsonl(output: string): ParsedCodexOutput {
  const parsed: ParsedCodexOutput = { eventKinds: [] };
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) continue;
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { continue; }
    visitJson(value, (object) => {
      const usage = usageFromObject(object);
      if (usage) parsed.usage = usage;
      parsed.model = parsed.model ?? stringField(object, ["model", "model_id", "modelName"]);
      const kind = stringField(object, ["type", "event", "kind", "name"]);
      if (kind) {
        parsed.eventKinds.push(kind);
        const lower = kind.toLowerCase();
        if ((lower.includes("turn") || lower.includes("agent")) && (lower.includes("complete") || lower.includes("done") || lower === "turn")) parsed.modelRounds = (parsed.modelRounds ?? 0) + 1;
        if (lower.includes("tool_call") || ((lower.includes("exec_command") || lower.includes("command.start")) && !lower.includes(".end"))) parsed.toolCalls = (parsed.toolCalls ?? 0) + 1;
        if (lower.includes("tool_result") || lower.includes("command.end") || lower.includes("exec_command.end")) parsed.toolResults = (parsed.toolResults ?? 0) + 1;
      }
    });
  }
  return parsed;
}

function emitSafely(emit: WorkerEventSink | undefined, event: Parameters<WorkerEventSink>[0]): void {
  try {
    emit?.(event);
  } catch {
    // Live adapter events are diagnostic only and cannot change worker truth.
  }
}

function failureResult(summary: string, signal: string | null, output: string, model?: string, usage?: WorkerUsageTelemetry): WorkerTerminalResult {
  return {
    ok: false,
    output,
    code: null,
    signal,
    telemetry: { status: usage ? "partial" : "unavailable", usage, model },
    failure: {
      code: signal ? "codex_cli_cancelled" : "codex_cli_failed",
      summary,
      diagnosticExcerpt: output.slice(-1_000),
    },
  };
}

export class CodexCliWorkerAdapter implements WorkerAdapter {
  readonly id = "codex-cli";
  readonly version: string;
  private readonly options: CodexCliWorkerAdapterOptions;

  constructor(options: CodexCliWorkerAdapterOptions = {}) {
    assertSafeOptions(options);
    this.options = options;
    this.version = options.harnessVersion?.trim()
      ? `${WORKER_ADAPTER_VERSION}+${options.harnessVersion.trim()}`
      : WORKER_ADAPTER_VERSION;
  }

  async run(task: WorkerTask, signal: AbortSignal, emit?: WorkerEventSink): Promise<WorkerTerminalResult> {
    const startedAt = new Date().toISOString();
    const invocation = buildCodexCliInvocation(task, this.options);
    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    emitSafely(emit, { type: "runtime", startedAt, lastActivityAt: startedAt, alive: true });

    return await new Promise((resolve) => {
      let output = "";
      let resolved = false;
      const finish = (result: WorkerTerminalResult) => {
        if (resolved) return;
        resolved = true;
        emitSafely(emit, { type: "runtime", startedAt, lastActivityAt: new Date().toISOString(), alive: false });
        resolve(result);
      };
      let child;
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: task.cwd,
          env: invocation.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        finish(failureResult(summary, signal.aborted ? "SIGTERM" : null, summary));
        return;
      }
      child.stdout.on("data", (chunk) => { output = boundedAppend(output, String(chunk), maxOutputBytes); });
      child.stderr.on("data", (chunk) => { output = boundedAppend(output, String(chunk), maxOutputBytes); });
      child.on("error", (error) => {
        const parsed = parseCodexCliJsonl(output);
        const summary = error instanceof Error ? error.message : String(error);
        finish(failureResult(summary, signal.aborted ? "SIGTERM" : null, boundedAppend(output, summary, maxOutputBytes), parsed.model, parsed.usage));
      });
      child.on("close", (code, processSignal) => {
        const parsed = parseCodexCliJsonl(output);
        for (const kind of parsed.eventKinds.slice(-20)) {
          emitSafely(emit, { type: "activity", phase: task.phase, kind, summary: `Codex CLI event: ${kind}` });
        }
        const activity = parsed.modelRounds !== undefined || parsed.toolCalls !== undefined || parsed.toolResults !== undefined
          ? { modelRounds: parsed.modelRounds ?? 0, toolCalls: parsed.toolCalls ?? 0, toolResults: parsed.toolResults ?? 0 }
          : undefined;
        const model = parsed.model ?? this.options.model ?? process.env.PI_NEXT_CODEX_MODEL ?? process.env.PI_NEXT_EVAL_MODEL;
        if (code === 0 && !signal.aborted) {
          finish({
            ok: true,
            output: output || "Codex CLI worker completed; independent grader determines pass/fail.",
            code: 0,
            signal: null,
            telemetry: { status: parsed.usage ? "complete" : "partial", usage: parsed.usage, activity, model },
          });
          return;
        }
        const summary = signal.aborted ? "Codex CLI worker cancelled" : `Codex CLI exited with code ${code ?? "null"}${processSignal ? ` signal ${processSignal}` : ""}`;
        finish({
          ok: false,
          output,
          code,
          signal: signal.aborted ? "SIGTERM" : processSignal,
          telemetry: { status: parsed.usage ? "partial" : "unavailable", usage: parsed.usage, activity, model },
          failure: { code: signal.aborted ? "codex_cli_cancelled" : "codex_cli_failed", summary, diagnosticExcerpt: output.slice(-1_000) },
        });
      });
    });
  }
}

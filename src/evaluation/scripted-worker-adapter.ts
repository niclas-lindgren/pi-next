import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  WORKER_ADAPTER_VERSION,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerEventSink,
  type WorkerTask,
  type WorkerTerminalResult,
} from "../coordination/worker-adapter.ts";

const execFileAsync = promisify(execFile);
export const MAX_SCRIPTED_WORKER_EVENTS = 100;

export type ScriptedWorkerBehavior =
  | "success"
  | "failure"
  | "blocked"
  | "timeout"
  | "wait-for-cancel"
  | "malformed";

export interface ScriptedWorkerWrite {
  path: string;
  content: string;
}

export interface ScriptedWorkerCommit {
  message: string;
  paths?: string[];
}

export interface ScriptedWorkerExpectation {
  cwd?: string;
  issueNumber?: number;
  runId?: string;
  phase?: string;
  coordinationCwd?: string;
  role?: string;
  candidateSha?: string;
  fixedPointSha?: string;
  authorityFingerprint?: string;
}

export interface ScriptedWorkerScript<TResult extends WorkerTerminalResult = WorkerTerminalResult> {
  name?: string;
  expect?: ScriptedWorkerExpectation;
  events?: readonly WorkerEvent[];
  writes?: readonly ScriptedWorkerWrite[];
  commit?: ScriptedWorkerCommit;
  behavior?: ScriptedWorkerBehavior;
  output?: string;
  result?: TResult;
  /** Deliberately invalid terminal payload for malformed-result regressions. */
  malformedResult?: unknown;
}

export interface ScriptedWorkerInvocation {
  index: number;
  scriptName: string;
  task: WorkerTask;
  abortedAtStart: boolean;
}

export class ScriptedWorkerBindingError extends Error {
  readonly code = "scripted_worker_binding_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "ScriptedWorkerBindingError";
  }
}

export class ScriptedWorkerExhaustedError extends Error {
  readonly code = "scripted_worker_exhausted";
  constructor(index: number) {
    super(`No scripted worker behavior remains for invocation ${index}`);
    this.name = "ScriptedWorkerExhaustedError";
  }
}

function resolveInside(cwd: string, path: string): string {
  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Scripted worker path escapes supplied cwd: ${path}`);
  }
  return target;
}

function cloneTask(task: WorkerTask): WorkerTask {
  return structuredClone(task);
}

function assertEqual(label: string, expected: unknown, actual: unknown): void {
  if (expected !== undefined && expected !== actual) {
    throw new ScriptedWorkerBindingError(
      `${label} mismatch: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertBinding(task: WorkerTask, expected: ScriptedWorkerExpectation | undefined): void {
  if (!expected) return;
  assertEqual("cwd", expected.cwd, task.cwd);
  assertEqual("issueNumber", expected.issueNumber, task.issueNumber);
  assertEqual("runId", expected.runId, task.runId);
  assertEqual("phase", expected.phase, task.phase);
  assertEqual("coordinationCwd", expected.coordinationCwd, task.coordinationCwd);
  assertEqual("role", expected.role, task.dispatch?.role);
  assertEqual("candidateSha", expected.candidateSha, task.dispatch?.candidateSha);
  assertEqual("fixedPointSha", expected.fixedPointSha, task.dispatch?.fixedPointSha);
  assertEqual("authorityFingerprint", expected.authorityFingerprint, task.dispatch?.authorityFingerprint);
}

function defaultResult(
  behavior: Exclude<ScriptedWorkerBehavior, "malformed" | "wait-for-cancel">,
  output = "",
): WorkerTerminalResult {
  switch (behavior) {
    case "success":
      return {
        ok: true,
        output,
        code: 0,
        signal: null,
        telemetry: { status: "complete" },
      };
    case "failure":
      return {
        ok: false,
        output,
        code: 1,
        signal: null,
        telemetry: { status: "complete" },
        failure: {
          code: "scripted_worker_failure",
          summary: output || "scripted worker failed",
          diagnosticExcerpt: (output || "scripted worker failed").slice(-1_000),
        },
      };
    case "blocked":
      return {
        ok: false,
        output,
        code: null,
        signal: null,
        telemetry: { status: "complete" },
        failure: {
          code: "scripted_worker_blocked",
          summary: output || "scripted worker blocked",
          diagnosticExcerpt: (output || "scripted worker blocked").slice(-1_000),
        },
      };
    case "timeout":
      return {
        ok: false,
        output,
        code: null,
        signal: "SIGTERM",
        telemetry: { status: "partial" },
        failure: {
          code: "scripted_worker_timeout",
          summary: output || "scripted worker timed out",
          diagnosticExcerpt: (output || "scripted worker timed out").slice(-1_000),
        },
      };
  }
}

function emitSafely(emit: WorkerEventSink | undefined, event: WorkerEvent): void {
  try {
    emit?.(structuredClone(event));
  } catch {
    // Scenario observations are diagnostic only; a throwing sink cannot alter worker truth.
  }
}

async function commitScriptedChanges(cwd: string, commit: ScriptedWorkerCommit): Promise<void> {
  const paths = commit.paths?.length ? commit.paths : ["-A"];
  if (paths[0] === "-A") {
    await execFileAsync("git", ["-C", cwd, "add", "-A"], { encoding: "utf8" });
  } else {
    for (const path of paths) resolveInside(cwd, path);
    await execFileAsync("git", ["-C", cwd, "add", "--", ...paths], { encoding: "utf8" });
  }
  await execFileAsync("git", ["-C", cwd, "commit", "--quiet", "-m", commit.message], {
    encoding: "utf8",
  });
}

function cancelledResult(): WorkerTerminalResult {
  return {
    ok: false,
    output: "scripted worker cancelled",
    code: null,
    signal: "SIGTERM",
    telemetry: { status: "partial" },
    failure: {
      code: "scripted_worker_cancelled",
      summary: "scripted worker cancelled",
      diagnosticExcerpt: "scripted worker cancelled",
    },
  };
}

/**
 * Deterministic protocol test double for the production WorkerAdapter seam.
 *
 * It deliberately knows nothing about Pi, authority stores, leases, promotion,
 * closure, or verification. A script can only observe the supplied task, emit a
 * bounded provider-neutral event stream, make bounded writes/commits inside the
 * already-authorized cwd, and return one terminal result.
 */
export class ScriptedWorkerAdapter<
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
> implements WorkerAdapter<WorkerTask, TResult> {
  readonly id = "scripted";
  readonly version = WORKER_ADAPTER_VERSION;
  readonly invocations: ScriptedWorkerInvocation[] = [];
  private cursor = 0;

  constructor(private readonly scripts: readonly ScriptedWorkerScript<TResult>[]) {}

  get remaining(): number {
    return Math.max(0, this.scripts.length - this.cursor);
  }

  async run(
    task: WorkerTask,
    signal: AbortSignal,
    emit?: WorkerEventSink,
  ): Promise<TResult> {
    const index = this.cursor++;
    const script = this.scripts[index];
    if (!script) throw new ScriptedWorkerExhaustedError(index);

    this.invocations.push({
      index,
      scriptName: script.name ?? `script-${index + 1}`,
      task: cloneTask(task),
      abortedAtStart: signal.aborted,
    });
    assertBinding(task, script.expect);

    const events = script.events ?? [];
    if (events.length > MAX_SCRIPTED_WORKER_EVENTS) {
      throw new Error(
        `Scripted worker event budget exceeded: ${events.length} > ${MAX_SCRIPTED_WORKER_EVENTS}`,
      );
    }
    for (const event of events) emitSafely(emit, event);

    for (const write of script.writes ?? []) {
      const path = resolveInside(task.cwd, write.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, write.content, "utf8");
    }
    if (script.commit) await commitScriptedChanges(task.cwd, script.commit);

    const behavior = script.behavior ?? "success";
    if (behavior === "wait-for-cancel") {
      if (!signal.aborted) {
        await new Promise<void>((resolveCancel) => {
          signal.addEventListener("abort", () => resolveCancel(), { once: true });
        });
      }
      return cancelledResult() as TResult;
    }
    if (behavior === "malformed") {
      return (script.malformedResult ?? { malformed: true }) as TResult;
    }
    if (script.result) return structuredClone(script.result);
    return defaultResult(behavior, script.output) as TResult;
  }
}

import { exec, execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configuredPath, loadPiNextConfig, type WorkerWatchdogPolicy } from "../../src/coordination/config.ts";
import { promisify } from "node:util";

import {
  IncrementalWorkerTelemetryParser,
  type WorkerTelemetryReport,
} from "./worker-telemetry.ts";
import {
  IncrementalWorkerActivityParser,
  type WorkerWorkLogEvent,
} from "./worker-activity.ts";
import type { WorkerDisplaySink } from "./worker-display.ts";
import type { WorkerDispatchPolicy } from "../../src/coordination/worker-dispatch.ts";
import {
  createWorkerFailureEvidence,
  type WorkerFailureEvidence,
} from "./worker-failure.ts";

const execFileAsync = promisify(execFile);
export const execAsync = promisify(exec);
export const FAILURE_LIMIT = 3_500;
export const MUTABLE_ISSUE_WORKER_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "pi_next_inspect",
  "pi_next_update",
  "pi_next_check",
  "pi_next_git",
  "safe_bash",
].join(",");
const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const WORKER_GIT_MUTATION_CONFIG_ARGS = ["-c", `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, "-c", "core.fsmonitor=false"];

function guardedGitMutationArgs(args: string[]): string[] {
  return process.env.PI_NEXT_ISSUE_WORKER === "1"
    ? [...WORKER_GIT_MUTATION_CONFIG_ARGS, ...args]
    : args;
}

/**
 * Diagnostic-only observer for host-delivery calls that `guardedHostCall`
 * swallows (`ctx.ui.notify`, `pi.appendEntry`-backed work-log delivery,
 * tool `onUpdate`). Delivery failures here are deliberately never allowed
 * to affect worker execution, which historically meant a broken/rejecting
 * host call (e.g. a stale session, an API mismatch) failed completely
 * silently — indistinguishable from "nothing to report yet". Set via
 * `setHostCallDiagnosticsSink()` from a module that can safely depend on
 * the crash logger (util-core.ts itself stays generation/crash-log-agnostic
 * to avoid a circular import — crash-log.ts already imports `runtimeDir`
 * from here).
 */
let hostCallDiagnosticsSink: ((error: unknown, label: string) => void) | undefined;

export function setHostCallDiagnosticsSink(
  sink: ((error: unknown, label: string) => void) | undefined,
): void {
  hostCallDiagnosticsSink = sink;
}

function reportSwallowedHostCallError(error: unknown, label: string): void {
  try {
    hostCallDiagnosticsSink?.(error, label);
  } catch {
    // The diagnostics sink itself must never affect worker execution either.
  }
}

/**
 * The single lifecycle-aware host-interaction boundary (#583). Host
 * delivery (UI notifications, tool `onUpdate` callbacks, queued
 * follow-ups, session creation/use) must never become an unhandled
 * rejection or synchronous throw when the host tears down mid-call, and —
 * once a caller supplies `isDisposed` — must be suppressed outright once
 * the owning extension generation has been torn down/replaced, instead of
 * only relying on a catch after the fact.
 *
 * util-core.ts deliberately stays generation-agnostic (no dependency on
 * loop-controller.ts, which owns the active-generation registry, to avoid
 * a circular import): callers bind `isDisposed` to their own
 * `ExtensionGeneration.isDisposed()`.
 *
 * A swallowed delivery failure is still reported to
 * `hostCallDiagnosticsSink` (diagnostic-only, itself failure-safe) so a
 * genuinely broken host call is no longer indistinguishable from an idle
 * worker with nothing yet to report.
 */
export function guardedHostCall(
  isDisposed: (() => boolean) | undefined,
  deliver: () => void | Promise<unknown>,
  label = "guardedHostCall",
): void {
  if (isDisposed?.()) return;
  try {
    void Promise.resolve(deliver()).catch((error) =>
      reportSwallowedHostCallError(error, label),
    );
  } catch (error) {
    // The host may synchronously reject/tear down mid-call.
    reportSwallowedHostCallError(error, label);
  }
}

/**
 * Progress updates are diagnostic only. Pi can dispose a tool call while a
 * verification subprocess is still unwinding, so a stale update callback
 * must never reject the tool or escape as an unhandled rejection.
 */
export function safeToolUpdate<T>(
  onUpdate: ((update: T) => void | Promise<void>) | undefined,
  update: T,
  isDisposed?: () => boolean,
): void {
  if (!onUpdate) return;
  guardedHostCall(isDisposed, () => onUpdate(update), "toolUpdate");
}

/** Deliver a UI notification through the lifecycle-aware host boundary. */
export function safeNotify(
  ctx: {
    ui: {
      notify(
        message: string,
        level: "info" | "warning" | "error",
      ): void | Promise<unknown>;
    };
  },
  message: string,
  level: "info" | "warning" | "error" = "info",
  isDisposed?: () => boolean,
): void {
  guardedHostCall(isDisposed, () => ctx.ui.notify(message, level), "notify");
}
const GIT_MUTATION_FAILURE_LIMIT = FAILURE_LIMIT;

/**
 * Run one issue-scoped model turn in a dedicated OS process.
 *
 * Pi's extension session API does not expose the runtime's cwd override to
 * extensions. Starting the worker with `spawn({ cwd })` gives the child its
 * own immutable process cwd without mutating or serializing the controller's
 * cwd. Every built-in tool and subprocess created by the child consequently
 * inherits the canonical issue worktree.
 */
export interface IssueWorkerResult {
  ok: boolean;
  output: string;
  code: number | null;
  signal: string | null;
  /** Structured, sanitized evidence retained when the child exits unsuccessfully. */
  failure?: WorkerFailureEvidence;
  /** Bounded aggregate usage/activity/model telemetry recovered from the
   * worker's `--mode json` event stream (#599); never fabricated as zero. */
  telemetry: WorkerTelemetryReport;
  watchdog?: WorkerWatchdogEvent;
}

export interface IssueWorkerRuntime {
  pid?: number;
  startedAt: string;
  lastActivityAt: string;
  lastActivityKind?: string;
  alive: boolean;
}

export interface WorkerWatchdogEvent {
  kind: "suspected_stall" | "worker_timeout";
  issueNumber?: number;
  runId?: string;
  phase?: string;
  pid?: number;
  wallClockMs: number;
  idleMs: number;
  lastActivityAt: string;
  lastActivityKind?: string;
  reason: string;
}

export interface IssueWorkerOptions {
  signal?: AbortSignal;
  executable?: string;
  executableArgs?: string[];
  /** Deterministic issue/run identity attached by the parent, never read from worker output. */
  issueNumber?: number;
  runId?: string;
  phase?: string;
  /** Immutable controller-selected worker contract. */
  dispatch?: WorkerDispatchPolicy;
  /** Reviewers are launched without Pi tools; they receive an exact candidate snapshot. */
  readOnly?: boolean;
  /**
   * The authoritative coordination root for this run's controller state
   * (`LoopState.coordinationCwd`), transported to the isolated child via
   * `PI_NEXT_COORDINATION_CWD` (#603). The worker's own `cwd` remains the
   * canonical issue worktree for git/tool/model execution; this value exists
   * solely so the registered `pi_next_update(loop_result)` tool — which runs
   * inside the child and only ever sees its own `ctx.cwd` — can resolve and
   * validate `state.json`/`result.json` against the real run authority
   * instead of a worktree-relative `.pi/runtime` path.
   */
  coordinationCwd?: string;
  /** Owner-bound live display sink for streaming child activity. */
  display?: WorkerDisplaySink;
  /** Normalized safe activity emitted while the child is still running. */
  onActivity?: (event: WorkerWorkLogEvent) => void;
  /** Best-effort wall-clock progress while the isolated worker is active. */
  onProgress?: (elapsedMs: number) => void;
  /** Bounded child runtime metadata for truthful status inspection. */
  onWorkerState?: (runtime: IssueWorkerRuntime) => void;
  /** Structured soft/hard watchdog observations. */
  onWatchdog?: (event: WorkerWatchdogEvent) => void;
  /** Explicit test/consumer override; production defaults come from config. */
  watchdog?: WorkerWatchdogPolicy;
  progressIntervalMs?: number;
}

export type IssueWorkerRunner = (
  cwd: string,
  prompt: string,
  options?: IssueWorkerOptions,
) => Promise<IssueWorkerResult>;

/**
 * Keep child workers independent from project package reconciliation. A worker
 * starts in an issue worktree, where Pi may otherwise see a project
 * `.pi/settings.json` and try to install a stale pinned package before it can
 * run the already-loaded extension (for example, `git checkout <missing
 * commit>`). The extension that launched the worker is an immutable local path,
 * so explicitly loading it is both safer and reproducible.
 */
function workerExtensionPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "pi-next.ts");
}

function workerWatchdogPolicy(cwd: string, options: IssueWorkerOptions): WorkerWatchdogPolicy {
  if (options.watchdog) return options.watchdog;
  try {
    const config = loadPiNextConfig(cwd);
    const role = options.dispatch?.role || options.phase;
    return (role && config.workerWatchdog.roles[role as keyof typeof config.workerWatchdog.roles]) || config.workerWatchdog.default;
  } catch {
    return { softIdleMs: 120_000, hardIdleMs: 600_000, hardWallMs: 2_700_000, terminationGraceMs: 5_000 };
  }
}

function persistWatchdogEvent(cwd: string, event: WorkerWatchdogEvent): void {
  try {
    writeJsonAtomic(join(runtimeDir(cwd), "pi-next-worker-watchdog.json"), event);
  } catch {
    // Diagnostics must never prevent bounded worker termination.
  }
}

export const runIssueWorker: IssueWorkerRunner = (cwd, prompt, options = {}) => {
  const watchdog = workerWatchdogPolicy(cwd, options);
  const executable = options.executable ?? process.execPath;
  const entrypoint = options.executableArgs ?? [process.argv[1]];
  if (!entrypoint[0]) {
    return Promise.reject(new Error("Unable to determine the Pi worker entrypoint"));
  }
  const isolatedExtensionArgs = options.executableArgs
    ? []
    : [
        "--no-approve",
        "--no-extensions",
        "--extension",
        workerExtensionPath(),
        // Mutable production workers get an explicit positive tool allowlist:
        // source file/search tools, pi-next lifecycle tools, and the guarded
        // safe_bash command runner. Raw bash and any future Pi/extension tools
        // stay unavailable unless the kernel deliberately adds them here.
        ...(options.readOnly ? [] : ["--tools", MUTABLE_ISSUE_WORKER_TOOLS]),
      ];
  const dispatchArgs = options.dispatch?.modelPolicy?.model
    ? ["--model", options.dispatch.modelPolicy.model]
    : [];
  if (options.dispatch?.modelPolicy?.thinking) {
    dispatchArgs.push("--thinking", options.dispatch.modelPolicy.thinking);
  }
  const child = spawn(executable, [
    ...entrypoint,
    ...isolatedExtensionArgs,
    ...dispatchArgs,
    ...(options.readOnly ? ["--no-tools"] : []),
    "--print",
    "--no-session",
    "--mode",
    "json",
    prompt,
  ], {
    cwd,
    env: {
      ...process.env,
      PI_NEXT_ISSUE_WORKER: "1",
      ...(options.runId ? { PI_NEXT_RUN_ID: options.runId } : {}),
      ...(options.issueNumber ? { PI_NEXT_ISSUE_NUMBER: String(options.issueNumber) } : {}),
      ...(options.coordinationCwd
        ? { PI_NEXT_COORDINATION_CWD: options.coordinationCwd }
        : {}),
      ...(options.dispatch
        ? {
            PI_NEXT_WORKER_ROLE: options.dispatch.role,
            PI_NEXT_WORKER_CAPABILITY: options.dispatch.capabilityProfile,
            PI_NEXT_WORKER_SKILLS: options.dispatch.skills.join(","),
          }
        : options.phase
          ? { PI_NEXT_WORKER_ROLE: options.phase }
          : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastActivityKind: string | undefined;
  let watchdogEvent: WorkerWatchdogEvent | undefined;
  let watchdogGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const reportRuntime = (alive: boolean) => {
    try {
      options.onWorkerState?.({
        pid: child.pid,
        startedAt: new Date(startedAt).toISOString(),
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        lastActivityKind,
        alive,
      });
    } catch {
      // Diagnostic/status callbacks must never affect worker execution.
    }
  };
  const activity = new IncrementalWorkerActivityParser(
    {
      issueNumber: options.issueNumber,
      runId: options.runId,
      phase: options.phase,
    },
    (event) => {
      lastActivityAt = Date.now();
      lastActivityKind = event.kind;
      options.onActivity?.(event);
    },
    (delta) => options.display?.liveDelta(delta),
    {
      onNdjsonRecord: (raw) => options.display?.recordNdjsonRecord(raw),
      onToolStart: () => options.display?.recordToolStart(),
    },
  );
  // Fed the same unbounded live chunks as `activity` above, so a long-running
  // worker's telemetry survives even though `output` below is bounded to a
  // small tail for failure diagnostics and would otherwise lose the leading
  // `session` event telemetry parsing requires (was previously parsed from
  // `output` post-hoc via parseWorkerTelemetry(), which silently produced
  // `status: "unavailable"` for any run longer than a few seconds).
  const telemetry = new IncrementalWorkerTelemetryParser({
    issueNumber: options.issueNumber,
    runId: options.runId,
    phase: options.phase,
  });
  const appendOutput = (chunk: Buffer | string, kind = "stderr") => {
    lastActivityAt = Date.now();
    lastActivityKind = kind;
    const value = String(chunk);
    output = `${output}${value}`.slice(-FAILURE_LIMIT);
    reportRuntime(true);
  };
  const appendStdout = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk);
    options.display?.recordStdoutBytes(bytes);
    const value = String(chunk);
    appendOutput(value, "stdout");
    // Only stdout is Pi's structured NDJSON wire stream. Stderr remains
    // failure/diagnostic output and must never be fed to either parser.
    activity.push(value);
    telemetry.push(value);
  };
  child.stdout.on("data", appendStdout);
  child.stderr.on("data", (chunk) => appendOutput(chunk, "stderr"));
  reportRuntime(true);
  const watchdogInterval = setInterval(() => {
    if (settled) return;
    const now = Date.now();
    const wallClockMs = now - startedAt;
    const idleMs = now - lastActivityAt;
    const kind = idleMs >= watchdog.softIdleMs ? "suspected_stall" : undefined;
    if (!watchdogEvent && kind) {
      watchdogEvent = {
        kind,
        issueNumber: options.issueNumber,
        runId: options.runId,
        phase: options.phase,
        pid: child.pid,
        wallClockMs,
        idleMs,
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        lastActivityKind,
        reason: `worker idle for ${Math.round(idleMs / 1_000)}s (soft threshold ${Math.round(watchdog.softIdleMs / 1_000)}s)`,
      };
      persistWatchdogEvent(cwd, watchdogEvent);
      options.onWatchdog?.(watchdogEvent);
      options.display?.watchdog?.(watchdogEvent);
      reportRuntime(true);
    }
    const timeout = idleMs >= watchdog.hardIdleMs || wallClockMs >= watchdog.hardWallMs;
    if (timeout && watchdogEvent?.kind !== "worker_timeout") {
      watchdogEvent = {
        ...watchdogEvent,
        kind: "worker_timeout",
        wallClockMs,
        idleMs,
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        lastActivityKind,
        reason: idleMs >= watchdog.hardIdleMs
          ? `worker idle for ${Math.round(idleMs / 1_000)}s (hard threshold ${Math.round(watchdog.hardIdleMs / 1_000)}s)`
          : `worker wall time ${Math.round(wallClockMs / 60_000)}m exceeded hard threshold ${Math.round(watchdog.hardWallMs / 60_000)}m`,
      };
      persistWatchdogEvent(cwd, watchdogEvent);
      options.onWatchdog?.(watchdogEvent);
      options.display?.watchdog?.(watchdogEvent);
      const pid = child.pid;
      if (pid) {
        terminate("SIGTERM");
        watchdogGraceTimer = setTimeout(() => {
          if (settled) return;
          terminate("SIGKILL");
        }, watchdog.terminationGraceMs);
        watchdogGraceTimer.unref?.();
      }
    }
  }, 1_000);
  watchdogInterval.unref?.();
  const progressInterval = options.onProgress || options.onWorkerState
    ? setInterval(
        () => {
          options.onProgress?.(Date.now() - startedAt);
          reportRuntime(true);
        },
        options.progressIntervalMs ?? 15_000,
      )
    : undefined;
  progressInterval?.unref?.();
  const terminate = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to the direct child when process-group signalling is unavailable.
      }
    }
    child.kill(signal);
  };
  const abort = () => terminate("SIGTERM");
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  return new Promise((resolve) => {
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdogInterval);
      if (watchdogGraceTimer) clearTimeout(watchdogGraceTimer);
      if (progressInterval) clearInterval(progressInterval);
      activity.finish();
      options.signal?.removeEventListener("abort", abort);
      reportRuntime(false);
      options.display?.finish(
        options.issueNumber,
        options.runId,
        signal ? "aborted" : code === 0 ? "completed" : "failed",
      );
      const ok = code === 0 && !signal;
      resolve({
        ok,
        output,
        code,
        signal,
        ...(ok ? {} : {
          failure: createWorkerFailureEvidence(
            { output, code, signal },
            {
              issueNumber: options.issueNumber,
              runId: options.runId,
              phase: options.phase,
              dispatch: options.dispatch,
            },
          ),
        }),
        telemetry: options.dispatch
          ? { ...telemetry.finish(), dispatch: {
              version: options.dispatch.version,
              role: options.dispatch.role,
              skills: options.dispatch.skills,
              capabilityProfile: options.dispatch.capabilityProfile,
            } }
          : telemetry.finish(),
        ...(watchdogEvent?.kind === "worker_timeout" ? { watchdog: watchdogEvent } : {}),
      });
    };
    child.once("error", (error) => {
      appendOutput(error.message);
      finish(1, null);
    });
    child.once("close", finish);
  });
};

/**
 * One explicit lifecycle/supervisor object per pi-next extension generation
 * (#583). Each controller worker-batch boundary starts a new generation;
 * host-session replacement is not part of ordinary loop progression. This
 * gives that generation a stable identity, a single `AbortSignal` background work (subprocesses, heartbeats, queued prompts)
 * can observe, a registry so bounded teardown can wait for outstanding
 * tracked tasks instead of abandoning them mid-flight, and a disposed-check
 * host-facing callbacks can consult before mutating a replacement
 * generation's state.
 *
 * This object only defines the lifecycle boundary itself. Threading its
 * `signal`/`isDisposed()` into subprocess runners, heartbeat loops, and
 * queued prompt delivery, and replacing `notifySafely`/`safeToolUpdate` with
 * a single disposed-aware host boundary, are separate follow-up steps
 * (#583).
 */
/** Optional classification for a tracked task, used to report per-kind teardown counts (#583). */
export type TrackedTaskKind = "subprocess";

export interface TrackOptions {
  kind?: TrackedTaskKind;
}

/**
 * Structured, bounded diagnostics for one generation teardown/replacement
 * event (#583), independent of any particular telemetry sink so
 * `createExtensionGeneration()` stays generation-agnostic. `tasksTracked`
 * counts every promise registered via `track()` (subprocess runs, and any
 * other tracked background work) at the moment teardown began;
 * `tasksSettled` is how many of those had already settled by the time
 * teardown finished (bounded by `timedOut`). `tasksCancelled` is the same
 * count exposed under the acceptance-criterion's literal wording: tasks
 * still tracked (and therefore receiving the abort signal) at teardown.
 * `subprocessesTerminated` is the subset of those tasks registered via
 * `track(task, { kind: "subprocess" })`, i.e. verification/build child
 * processes that were sent SIGTERM by this teardown.
 */
export interface GenerationTeardownDiagnostics {
  generationId: string;
  teardownReason: string;
  tasksTracked: number;
  tasksSettled: number;
  timedOut: boolean;
  tasksCancelled: number;
  subprocessesTerminated: number;
}

export interface ExtensionGeneration {
  readonly id: string;
  readonly signal: AbortSignal;
  /** True once teardown has begun; host-facing callbacks must consult this before delivering work. */
  isDisposed(): boolean;
  /** Track a background task so bounded teardown waits for it instead of abandoning it. */
  track<T>(task: Promise<T>, options?: TrackOptions): Promise<T>;
  /**
   * Abort the signal, then wait (bounded) for tracked tasks to settle or the
   * timeout to elapse, returning structured diagnostics either way.
   */
  teardown(
    reason: string,
    timeoutMs?: number,
  ): Promise<GenerationTeardownDiagnostics>;
}

const DEFAULT_GENERATION_TEARDOWN_TIMEOUT_MS = 10_000;
let generationSequence = 0;

export function createExtensionGeneration(
  label = "generation",
): ExtensionGeneration {
  const id = `${label}-${Date.now()}-${++generationSequence}`;
  const controller = new AbortController();
  const tasks = new Map<Promise<unknown>, TrackOptions>();
  let disposed = false;
  let teardownPromise: Promise<GenerationTeardownDiagnostics> | undefined;

  const track = <T>(task: Promise<T>, options: TrackOptions = {}): Promise<T> => {
    tasks.set(task, options);
    const untrack = () => tasks.delete(task);
    task.then(untrack, untrack);
    return task;
  };

  const teardown = (
    reason: string,
    timeoutMs: number = DEFAULT_GENERATION_TEARDOWN_TIMEOUT_MS,
  ): Promise<GenerationTeardownDiagnostics> => {
    if (teardownPromise) return teardownPromise;
    disposed = true;
    if (!controller.signal.aborted) controller.abort(reason);
    const tasksTracked = tasks.size;
    const subprocessesTerminated = [...tasks.values()].filter(
      (options) => options.kind === "subprocess",
    ).length;
    const drain = Promise.allSettled([...tasks.keys()]).then(
      () => true as const,
    );
    const bounded = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    teardownPromise = Promise.race([drain, bounded]).then((settledInTime) => ({
      generationId: id,
      teardownReason: reason,
      tasksTracked,
      tasksSettled: settledInTime ? tasksTracked : tasksTracked - tasks.size,
      timedOut: !settledInTime,
      tasksCancelled: tasksTracked,
      subprocessesTerminated,
    }));
    return teardownPromise;
  };

  return {
    id,
    signal: controller.signal,
    isDisposed: () => disposed,
    track,
    teardown,
  };
}

/**
 * Combines a host-provided per-call signal with an owning generation's
 * signal so a subprocess/heartbeat aborts when either the host cancels the
 * individual call or the generation that owns it is torn down/replaced
 * (#583). Returns `undefined` when no signal is present so existing callers
 * that omit `signal` keep behaving exactly as before.
 */
export function combineSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export interface VerificationRunResult {
  ok: boolean;
  output: string;
  code: number | null;
  signal: string | null;
}

export function runVerificationCommand(
  cwd: string,
  label: string,
  command: string | string[],
  options: {
    shell?: boolean;
    timeoutMs?: number;
    heartbeatMs?: number;
    onHeartbeat?: (text: string) => void | Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<VerificationRunResult> {
  const args = ["scripts/run-verification.mjs", "--label", label];
  if (options.shell) args.push("--shell");
  const commandArgs = Array.isArray(command)
    ? command
    : options.shell
      ? [command]
      : command.trim().split(/\s+/);
  args.push("--", ...commandArgs);
  const env =
    options.heartbeatMs === undefined
      ? process.env
      : { ...process.env, VERIFY_HEARTBEAT_MS: String(options.heartbeatMs) };
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const append = (chunk: Buffer) => {
    chunks.push(String(chunk));
    while (chunks.join("").length > 16_000) chunks.shift();
  };
  const abort = () => child.kill("SIGTERM");
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  child.stderr.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    append(chunk);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      if (line.startsWith("Still running ")) {
        // The child can outlive the tool call during teardown. Progress is
        // diagnostic only; never allow a disposed host callback to escape the
        // stream event as an uncaught exception or unhandled rejection.
        safeToolUpdate(options.onHeartbeat, line);
      }
    }
  });
  child.stdout.on("data", append);
  const timeout = setTimeout(
    () => child.kill("SIGTERM"),
    options.timeoutMs ?? 1_800_000,
  );
  return new Promise((resolve) => {
    const finish = (code: number | null, signal: string | null) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0 && !signal,
        output: chunks.join(""),
        code,
        signal,
      });
    };
    child.on("close", finish);
    child.on("error", (error) => {
      append(Buffer.from(error.message));
      finish(1, null);
    });
  });
}

function normalizeGitOutput(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export async function gitRaw(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
): Promise<string> {
  const effectiveArgs = guardedGitMutationArgs(args);
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...effectiveArgs], {
    cwd,
    maxBuffer,
    encoding: "utf8",
  });
  return normalizeGitOutput(stdout);
}

export async function git(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
): Promise<string> {
  return (await gitRaw(cwd, args, maxBuffer)).trim();
}

/** Run a Git command that may invoke hooks without buffering its full output. Worker-triggered mutations disable hooks. */
export function gitMutation(cwd: string, args: string[]): Promise<string> {
  const effectiveArgs = guardedGitMutationArgs(args);
  const child = spawn("git", ["-C", cwd, ...effectiveArgs], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const append = (chunk: Buffer | string) => {
    tail = `${tail}${String(chunk)}`.slice(-GIT_MUTATION_FAILURE_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error?: Error,
      code?: number | null,
      signal?: string | null,
    ) => {
      if (settled) return;
      settled = true;
      if (error) {
        const evidence = tail.trim();
        reject(new Error(`${error.message}${evidence ? `\n${evidence}` : ""}`));
        return;
      }
      if (code !== 0 || signal) {
        const status = signal
          ? `signal ${signal}`
          : `code ${code ?? "unknown"}`;
        const evidence = tail.trim();
        reject(
          new Error(
            `git ${effectiveArgs.join(" ")} failed (${status})${evidence ? `:\n${evidence}` : ""}`,
          ),
        );
        return;
      }
      resolve(normalizeGitOutput(tail));
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(undefined, code, signal));
  });
}

export type CommitUnreachableStatus =
  | "unknown-object"
  | "dangling"
  | "on-deleted-branch"
  | "local-only-unpushed";

export interface CommitReachabilityDetail {
  sha: string;
  status: CommitUnreachableStatus;
}

export interface CommitReachabilityResult {
  reachable: string[];
  unreachable: string[];
  unreachableDetails: CommitReachabilityDetail[];
}

/**
 * Classify why a single commit SHA is not reachable from `ref`:
 *  - "unknown-object": the object does not exist in this repository at all.
 *  - "local-only-unpushed": the object exists and is reachable from at least
 *    one local or remote-tracking branch, but not from `ref` — most likely
 *    committed locally and never pushed/merged.
 *  - "on-deleted-branch": the object exists and appears in some ref's
 *    reflog history (it was once reachable from a branch tip) but is not
 *    reachable from any current branch or `ref` — the branch that held it
 *    was most likely deleted, reset, or rebased away.
 *  - "dangling": the object exists but has no current branch/tag containing
 *    it and no reflog trace — a true orphaned/unreferenced commit object.
 */
async function classifyUnreachableCommit(
  cwd: string,
  sha: string,
): Promise<CommitUnreachableStatus> {
  const exists = await git(cwd, ["cat-file", "-e", `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
  if (!exists) return "unknown-object";

  const containingBranches = await git(cwd, [
    "branch",
    "-a",
    "--contains",
    sha,
  ]).catch(() => "");
  if (containingBranches.trim().length) return "local-only-unpushed";

  const reflogShas = await git(cwd, [
    "log",
    "--walk-reflogs",
    "--all",
    "--format=%H",
  ]).catch(() => "");
  if (reflogShas.split(/\r?\n/).includes(sha)) return "on-deleted-branch";

  return "dangling";
}

/**
 * Check whether each candidate commit SHA is reachable from `ref` (default
 * `origin/main`) using `git merge-base --is-ancestor`. Any git error for a
 * given SHA — unknown object, dangling commit, deleted branch, or any other
 * failure — classifies that SHA as unreachable so callers fail safe instead
 * of silently trusting unresolved evidence. Each unreachable SHA is further
 * classified with a specific status via `unreachableDetails` instead of a
 * single generic "unreachable" bucket.
 */
export async function commitsReachableFromRef(
  cwd: string,
  shas: readonly string[],
  ref = "origin/main",
): Promise<CommitReachabilityResult> {
  const reachable: string[] = [];
  const unreachable: string[] = [];
  const unreachableDetails: CommitReachabilityDetail[] = [];
  for (const sha of shas) {
    try {
      await git(cwd, ["merge-base", "--is-ancestor", sha, ref]);
      reachable.push(sha);
    } catch {
      unreachable.push(sha);
      unreachableDetails.push({
        sha,
        status: await classifyUnreachableCommit(cwd, sha),
      });
    }
  }
  return { reachable, unreachable, unreachableDetails };
}

/** Format per-SHA unreachability details as `<sha> (<status>)` lines. */
export function formatUnreachableCommitDetails(
  details: readonly CommitReachabilityDetail[],
): string {
  return details
    .map((detail) => `- ${detail.sha} (${detail.status})`)
    .join("\n");
}

export function psDir(cwd: string): string {
  const config = loadPiNextConfig(cwd);
  return configuredPath(cwd, config.workflow.stateDir);
}

export function workflowPath(
  cwd: string,
  key: "stateDir" | "planPath" | "verifyPath" | "archiveDir" | "deferredDir" | "skillPath" | "tuningPath" | "diagnosticsPath" | "helperDir",
): string {
  const config = loadPiNextConfig(cwd);
  return configuredPath(cwd, config.workflow[key]);
}

export type PlanResolution =
  | { kind: "none" }
  | {
      kind: "resolved";
      path: string;
      issueNumber: number;
      provenance: "canonical" | "legacy-issue-scoped";
    }
  | {
      kind: "unresolved" | "ambiguous";
      paths: string[];
      reason: string;
    };

export class PlanAuthorityError extends Error {
  readonly code: "unresolved" | "ambiguous" | "unowned";
  readonly paths: string[];

  constructor(
    code: "unresolved" | "ambiguous" | "unowned",
    message: string,
    paths: string[] = [],
  ) {
    super(message);
    this.name = "PlanAuthorityError";
    this.code = code;
    this.paths = paths;
  }
}

function issueNumberFromPlan(path: string): number | undefined {
  const match = readFileSync(path, "utf8").match(
    /\*\*GitHub-Issue:\*\*\s*#(\d+)/i,
  );
  const issueNumber = Number.parseInt(match?.[1] || "", 10);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined;
}

/** Return only the canonical PLAN.md path; discovery is not ownership. */
export function planFile(cwd: string): string {
  const config = loadPiNextConfig(cwd);
  return configuredPath(cwd, config.workflow.planPath);
}

/**
 * Discover a plan without treating its presence as executable authority.
 * Canonical PLAN.md wins over legacy artifacts, while malformed and multiple
 * issue-scoped plans remain explicit resolution failures for the caller.
 */
export function resolvePlanIdentity(cwd: string): PlanResolution {
  const directory = psDir(cwd);
  const canonical = planFile(cwd);
  if (existsSync(canonical)) {
    const issueNumber = issueNumberFromPlan(canonical);
    return issueNumber
      ? {
          kind: "resolved",
          path: canonical,
          issueNumber,
          provenance: "canonical",
        }
      : {
          kind: "unresolved",
          paths: [canonical],
          reason:
            "PLAN.md does not contain a valid **GitHub-Issue:** #N identity",
        };
  }

  if (!existsSync(directory)) return { kind: "none" };
  const issuePlans = readdirSync(directory)
    .filter((name) => /^PLAN-[^/]+\.md$/.test(name))
    .map((name) => join(directory, name));
  if (issuePlans.length === 0) return { kind: "none" };
  if (issuePlans.length !== 1) {
    return {
      kind: "ambiguous",
      paths: issuePlans,
      reason:
        "Multiple issue-scoped PLAN artifacts require explicit authority reconciliation",
    };
  }
  const issueNumber = issueNumberFromPlan(issuePlans[0]);
  return issueNumber
    ? {
        kind: "resolved",
        path: issuePlans[0],
        issueNumber,
        provenance: "legacy-issue-scoped",
      }
    : {
        kind: "unresolved",
        paths: issuePlans,
        reason:
          "Issue-scoped PLAN artifact does not contain a valid **GitHub-Issue:** #N identity",
      };
}

export function verifyFile(cwd: string): string {
  const config = loadPiNextConfig(cwd);
  return configuredPath(cwd, config.workflow.verifyPath);
}

export function lockFile(cwd: string): string {
  return join(psDir(cwd), ".lock");
}

export function markerFile(cwd: string): string {
  return join(psDir(cwd), ".continue-here.md");
}

export function runtimeDir(cwd: string): string {
  return join(cwd, ".pi", "runtime");
}

export function qualityEvidenceFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-quality.json");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runHelper(
  cwd: string,
  name: string,
  args: string[] = [],
) {
  const config = loadPiNextConfig(cwd);
  const path = join(configuredPath(cwd, config.workflow.helperDir), name);
  const { stdout, stderr } = await execFileAsync(path, args, {
    cwd,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export function parseState(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0
          ? [line, ""]
          : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

export function errorOutput(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  return [value.stdout, value.stderr, value.message]
    .filter((part): part is string => typeof part === "string" && Boolean(part))
    .join("\n");
}

export function failureEvidence(output: string): string {
  const lines = output.split(/\r?\n/);
  const failures = lines.filter((line) =>
    /\b(FAIL|FAILED|ERROR|Error|TypeError|AssertionError|ReferenceError|SyntaxError|Unhandled|Exception)\b/.test(
      line,
    ),
  );
  return (failures.length ? failures : lines.slice(-80))
    .join("\n")
    .slice(-FAILURE_LIMIT);
}

export function writeLog(cwd: string, prefix: string, content: string): string {
  const dir = join(cwd, ".pi", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  writeFileSync(file, content, "utf8");
  return file;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

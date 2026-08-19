import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runtimeDir, setHostCallDiagnosticsSink } from "./util-core.ts";

/**
 * Diagnostic-only safety net for otherwise-silent pi-next crashes (#583).
 *
 * This intentionally does NOT try to keep the process alive: swallowing an
 * uncaughtException/unhandledRejection without the generation-scoped
 * cancellation work #583 requires would risk continuing in a corrupted
 * state or leaving stale timers/heartbeats/subprocesses running. It only
 * guarantees that, before the process exits the way it already does today,
 * a bounded record of *why* lands in a durable file instead of vanishing.
 */

const CRASH_LOG_ENTRY_LIMIT = 200;

function crashLogFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-crash-log.jsonl");
}

/** Trim the crash log to its last N entries so it never grows unbounded. */
function trimCrashLog(path: string): void {
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = existing.split("\n").filter(Boolean);
  if (lines.length <= CRASH_LOG_ENTRY_LIMIT) return;
  try {
    writeFileSync(path, `${lines.slice(-CRASH_LOG_ENTRY_LIMIT).join("\n")}\n`, "utf8");
  } catch {
    // Best-effort trim; an oversized file is still preferable to losing the
    // crash record we are about to append.
  }
}

/**
 * Append a bounded diagnostic record for an otherwise-unhandled error.
 * Never throws: a broken filesystem must not prevent the process from
 * exiting the way it would have anyway.
 */
export type CrashDiagnosticKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "signal:SIGHUP"
  | "signal:SIGTERM"
  | "hostCallSwallowed";

export function recordCrashDiagnostic(
  cwd: string,
  kind: CrashDiagnosticKind,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    const file = crashLogFile(cwd);
    const record = {
      at: new Date().toISOString(),
      pid: process.pid,
      kind,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...context,
    };
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    trimCrashLog(file);
  } catch {
    // Logging is diagnostic-only; a failure here must not mask or replace
    // the original crash.
  }
}

let installed = false;
let knownCwd: string | undefined;

/**
 * Track the most recently observed coordination cwd so a crash that happens
 * between command invocations (e.g. inside a background timer) still lands
 * next to the rest of pi-next's runtime diagnostics.
 */
export function trackCrashLoggerCwd(cwd: string): void {
  knownCwd = cwd;
}

/**
 * Record a swallowed host-delivery failure (e.g. `pi.appendEntry` for the
 * live work-log transcript) against the most recently tracked cwd, for
 * callers outside util-core.ts's `guardedHostCall`/diagnostics-sink chain.
 * Never throws. A no-op until some `trackCrashLoggerCwd`/`installCrashLogger`
 * call has established a cwd.
 */
export function reportSwallowedHostDeliveryFailure(
  error: unknown,
  label: string,
): void {
  try {
    if (!knownCwd) return;
    recordCrashDiagnostic(knownCwd, "hostCallSwallowed", error, { label });
  } catch {
    // Diagnostics must never affect the caller they are observing.
  }
}

/**
 * Install process-level uncaughtException/unhandledRejection listeners once
 * per process. Logs a bounded diagnostic record, then preserves whatever
 * crash behavior the process already had.
 *
 * The pi host itself registers its own `uncaughtException` handler (via
 * `process.prependListener`) that restores the terminal and calls
 * `process.exit(1)`. A plain `process.on()` listener is appended *after*
 * that handler, so the host's synchronous `process.exit()` runs first and
 * this logger never gets a turn — which is exactly why the first version of
 * this file produced no log for a real crash. Registering with
 * `prependListener` here instead guarantees this listener always runs
 * first, before any handler already registered (including the host's) or
 * registered later, regardless of load order.
 *
 * Only exit here when no other listener exists to do it (checked via
 * `listenerCount` *after* this handler has been added, so a count of 1
 * means "only us"). When the host (or anything else) also has a handler,
 * defer to it entirely so its own cleanup/exit-code semantics are
 * preserved unchanged.
 */
export function installCrashLogger(cwd: string): void {
  trackCrashLoggerCwd(cwd);
  // Registered every call (not gated by `installed`) so a diagnostics sink
  // is present even if a later extension reload replaced the closures the
  // earlier install captured; recordCrashDiagnostic() itself is cheap and
  // idempotent, so re-registering the same sink shape is harmless.
  setHostCallDiagnosticsSink((error, label) =>
    recordCrashDiagnostic(knownCwd ?? cwd, "hostCallSwallowed", error, { label }),
  );
  if (installed) return;
  installed = true;

  process.prependListener("uncaughtException", (error) => {
    recordCrashDiagnostic(knownCwd ?? cwd, "uncaughtException", error);
    if (process.listenerCount("uncaughtException") <= 1) process.exit(1);
  });

  process.prependListener("unhandledRejection", (reason) => {
    recordCrashDiagnostic(knownCwd ?? cwd, "unhandledRejection", reason);
    if (process.listenerCount("unhandledRejection") <= 1) process.exit(1);
  });

  // SIGHUP/SIGTERM are not application errors: the pi host treats either as
  // a request for a *graceful* shutdown (drains input, tears down the TUI,
  // exits 0 — see interactive-mode.js). That looks identical to a silent
  // crash from the terminal ("pi died entirely", no output, exit code 0),
  // most plausibly caused by the controlling terminal/SSH/tmux session
  // hanging up mid-operation rather than a pi-next bug. Log receipt (only)
  // so a future occurrence is distinguishable from a real uncaught error,
  // without altering the host's own shutdown behavior in any way.
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.prependListener(signal, () => {
      recordCrashDiagnostic(
        knownCwd ?? cwd,
        `signal:${signal}`,
        new Error(`Process received ${signal}`),
      );
    });
  }
}

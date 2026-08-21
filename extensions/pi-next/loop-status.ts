import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPiNextConfig } from "../../src/coordination/config.ts";
import {
  listLoopStates,
  loopRuntimeDir,
  runtimeCwdFor,
  type LoopState,
} from "./loop-state.ts";

export type ControllerLiveness = "alive" | "dead" | "unknown" | "not-running";
export type LoopPresentationState =
  | "running"
  | "abandoned"
  | "unknown"
  | "completed"
  | "idle"
  | "blocked"
  | "failed"
  | "stopped"
  | "interrupted";

export interface LoopStatusRecord {
  state: LoopState;
  controller: ControllerLiveness;
  presentation: LoopPresentationState;
  /** PID is shown only when the lock is structurally valid. */
  controllerPid?: number;
}

export interface LoopStatusSelection {
  current?: LoopStatusRecord;
  /** More than one session candidate is actionable but no one live owner wins. */
  ambiguous: boolean;
}

export interface LoopStatusOptions {
  processAlive?: (pid: number) => boolean;
  /** Fresh authority result, when the caller performed the bounded lease read. */
  authoritativeRunId?: string;
  authorityUnavailable?: boolean;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controllerLockFile(cwd: string, state: LoopState): string {
  return join(loopRuntimeDir(runtimeCwdFor(cwd, state), state.runId), "controller.lock");
}

/**
 * Inspect only the local controller lock. This is presentation evidence, not
 * ownership: a live PID never grants a lease and a dead PID never mutates one.
 */
export function controllerLiveness(
  cwd: string,
  state: LoopState,
  processAlive = defaultProcessAlive,
): { liveness: ControllerLiveness; pid?: number } {
  if (state.status !== "running") return { liveness: "not-running" };
  const path = controllerLockFile(cwd, state);
  if (!existsSync(path)) return { liveness: "unknown" };
  try {
    const lock = readFileSync(path, "utf8");
    const lockRunId = lock.match(/^run_id=(.+)$/m)?.[1]?.trim();
    const pid = Number.parseInt(lock.match(/^pid=(\d+)$/m)?.[1] || "0", 10);
    if (lockRunId !== state.runId || !Number.isInteger(pid) || pid <= 0) {
      return { liveness: "unknown" };
    }
    return { liveness: processAlive(pid) ? "alive" : "dead", pid };
  } catch {
    return { liveness: "unknown" };
  }
}

export function classifyLoopState(
  cwd: string,
  state: LoopState,
  options: LoopStatusOptions = {},
): LoopStatusRecord {
  const evidence = controllerLiveness(cwd, state, options.processAlive);
  let presentation: LoopPresentationState = state.status;
  if (state.status === "running") {
    presentation = evidence.liveness === "alive"
      ? "running"
      : evidence.liveness === "dead"
        ? "abandoned"
        : "unknown";
  }
  return {
    state,
    controller: evidence.liveness,
    presentation,
    ...(evidence.pid ? { controllerPid: evidence.pid } : {}),
  };
}

export function classifyLoopStates(
  cwd: string,
  states = listLoopStates(cwd),
  options: LoopStatusOptions = {},
): LoopStatusRecord[] {
  return states.map((state) => classifyLoopState(cwd, state, options));
}

/** Resolve an identity for presentation without using timestamps as authority. */
export function selectCurrentLoop(
  records: readonly LoopStatusRecord[],
  preferredRunId?: string,
  ownerSessionId?: string,
): LoopStatusSelection {
  if (preferredRunId) {
    return { current: records.find((record) => record.state.runId === preferredRunId), ambiguous: false };
  }
  if (!ownerSessionId) return { ambiguous: false };
  const candidates = records.filter((record) => record.state.sessionId === ownerSessionId);
  if (candidates.length === 1) return { current: candidates[0], ambiguous: false };
  if (!candidates.length) return { ambiguous: false };

  // A single proven-live controller is the only mechanical tie breaker. If
  // none or several are live, refuse to guess from mtime/run ID.
  const live = candidates.filter((record) => record.controller === "alive");
  if (live.length === 1) return { current: live[0], ambiguous: false };
  return { ambiguous: true };
}

function issueLabel(state: LoopState): string {
  return state.activeIssueNumber ? `#${state.activeIssueNumber}` : "no issue";
}

function recordLine(record: LoopStatusRecord): string {
  const state = record.state;
  const issue = state.activeIssueNumber
    ? state.issueMetrics.find((item) => item.issueNumber === state.activeIssueNumber)
    : state.issueMetrics.at(-1);
  const policy = loadPiNextConfig(record.state.coordinationCwd || process.cwd()).convergence;
  const budget = issue
    ? ` · budget=${Math.round(Math.min(1, Math.max((issue.transitions || 0) / policy.hardTransitions, (issue.wallClockMs || 0) / policy.hardWallMs, issue.totalTokens / policy.hardTokens)) * 100)}% transitions=${issue.transitions || 0} workers=${issue.workerLaunches || 0}${issue.planTasksAtSelection !== undefined ? ` tasks=${issue.planTasksRemaining ?? 0}/${issue.planTasksAtSelection}` : ""}`
    : "";
  const controller = record.controller === "alive"
    ? `controller alive pid=${record.controllerPid}`
    : record.controller === "dead"
      ? "controller dead"
      : record.controller === "unknown"
        ? "controller liveness unknown"
        : "controller not running";
  const reason = state.lastReason ? ` · ${state.lastReason.replace(/\s+/g, " ").slice(0, 160)}` : "";
  return `${state.runId} · ${issueLabel(state)} · ${record.presentation} · ${controller}${budget}${reason}`;
}

function counts(records: readonly LoopStatusRecord[]): string {
  const historical = records.filter((record) => !["running", "abandoned", "unknown"].includes(record.presentation));
  const terminal = new Map<string, number>();
  for (const record of historical) terminal.set(record.presentation, (terminal.get(record.presentation) || 0) + 1);
  const details = [...terminal.entries()].map(([key, value]) => `${key}=${value}`).join(", ");
  const stale = records.filter((record) => record.state.status === "running" && record.presentation !== "running").length;
  return `Historical: ${historical.length}${details ? ` (${details})` : ""}${stale ? ` · stale-running=${stale}` : ""}`;
}

/**
 * Bounded, actionable status text shared by the loop command and tests. The
 * default intentionally summarizes old history; `verbose`/`history` is the
 * explicit diagnostic escape hatch.
 */
export function renderLoopStatus(
  cwd: string,
  ownerSessionId?: string,
  preferredRunId?: string,
  mode: "summary" | "verbose" = "summary",
  options: LoopStatusOptions = {},
): string {
  const records = classifyLoopStates(cwd, undefined, options);
  let selection = selectCurrentLoop(records, preferredRunId, ownerSessionId);
  const authoritative = options.authoritativeRunId
    ? records.find((record) => record.state.runId === options.authoritativeRunId)
    : undefined;
  // A fresh lease read is the only authority-backed tie breaker for multiple
  // historical records. It may select the session's exact abandoned owner,
  // but never makes a foreign run the current session's run.
  if (!selection.current && authoritative && (!ownerSessionId || authoritative.state.sessionId === ownerSessionId)) {
    selection = { current: authoritative, ambiguous: false };
  }
  const live = records.filter((record) => record.controller === "alive");
  const actionable = records.filter((record) => ["running", "abandoned", "unknown"].includes(record.presentation));
  const current = selection.current;
  const lines: string[] = [];

  if (current) {
    lines.push(`Current run: ${recordLine(current)}`);
  } else if (selection.ambiguous) {
    lines.push("Current run: ambiguous (multiple session records without one proven live controller)");
  } else if (ownerSessionId) {
    lines.push(`Current run: none for session ${ownerSessionId}`);
  } else {
    lines.push("Current run: none (session identity unavailable; refusing to guess)");
  }
  if (current) {
    lines.push(`Detail: run=${current.state.runId} · ${issueLabel(current.state)} · ${current.presentation} · step ${current.state.step}/${current.state.maxSteps} · ${Math.max(0, current.state.remainingIssues)} remaining`);
    if (current.state.lastReason) lines.push(`Reason: ${current.state.lastReason.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  if (authoritative && (!current || authoritative.state.runId !== current.state.runId)) {
    lines.push(`Authoritative recoverable: ${recordLine(authoritative)}`);
  } else if (options.authorityUnavailable) {
    lines.push("Authoritative recoverable: unknown (lease authority unavailable; no local record was promoted)");
  }
  lines.push(`Live controllers: ${live.length}${live.length ? ` (${live.map((record) => record.state.runId).join(", ")})` : ""}`);
  if (live.length > 1) lines.push("Invariant violation: multiple live local controllers detected; recovery remains fail-closed.");
  lines.push(`Abandoned/stale candidates: ${actionable.filter((record) => record.presentation !== "running").length} (authority/worktree checks still required)`);
  lines.push(counts(records));

  if (mode === "verbose") {
    if (records.length) lines.push("History:", ...records.map(recordLine));
  } else {
    const recentActionable = actionable.filter((record) => !current || record.state.runId !== current.state.runId).slice(0, 5);
    const terminal = records.filter((record) => !["running", "abandoned", "unknown"].includes(record.presentation)).slice(0, 3);
    const recent = [...recentActionable, ...terminal];
    if (recent.length) lines.push("Recent:", ...recent.map(recordLine));
  }
  return lines.join("\n");
}
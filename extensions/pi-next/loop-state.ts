import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { IssueLease } from "./issue-authority.ts";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { piNextRuntimeIdentity } from "../../src/version.ts";
import { extractCommitEvidenceShas } from "./acceptance-verification.ts";
import {
  changeFiles,
  commitsReachableFromRef,
  formatUnreachableCommitDetails,
  git,
  markerFile,
  planFile,
  removeFile,
  runtimeDir,
  verifyFile,
  writeJsonAtomic,
} from "./util.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 1;
export const MAX_ISSUES = 50;
const MAX_ISSUE_METRICS = 20;
export const MAX_STEPS = 500;

export type LoopOutcome =
  | "continue"
  | "done"
  | "archived"
  | "defer_issue"
  | "block_issue"
  | "blocked"
  | "idle"
  | "failed";

export type LoopStatus =
  | "running"
  | "completed"
  | "idle"
  | "blocked"
  | "failed"
  | "stopped"
  | "interrupted";

export interface LoopUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface LoopMetrics extends LoopUsage {
  sessions: number;
  prompts: number;
  modelDurationMs: number;
  /** Count of prompts where child-worker usage telemetry could not be
   * recovered at all (#599) — distinct from a prompt that genuinely used
   * zero tokens. The numeric usage totals above only ever sum known values. */
  telemetryUnavailable: number;
}

export type LoopIssueDisposition = "active" | "completed" | "deferred" | "blocked";

/** Durable, bounded recovery evidence for a worker boundary without a result. */
export interface LoopRecoveryState {
  missingLoopResults: number;
  automaticSettlements: number;
  automaticResumes: number;
  exhausted: number;
  /** Attempts are counted per normalized worker-boundary fingerprint. */
  attemptsByFingerprint: Record<string, number>;
  /** Maximum retries allowed for the current recovery policy. */
  retryLimit?: number;
  lastFingerprint?: string;
  /** Boundary identity for deciding whether a previous fingerprint is reusable. */
  lastRecoveryStep?: number;
  lastRecoveryIssueNumber?: number;
  lastOutcome?:
    | "reconciling"
    | "settled_from_durable_evidence"
    | "resuming_same_issue"
    | "recovery_unsafe"
    | "recovery_exhausted";
  lastReason?: string;
  updatedAt?: string;
}

export interface LoopIssueMetrics extends LoopMetrics {
  issueNumber: number;
  disposition: LoopIssueDisposition;
  updatedAt: string;
  reason?: string;
}

export interface DeferredIssue {
  issueNumber: number;
  reason: string;
  deferredAt: string;
  kind?: "deferred" | "blocked";
  parkedPlan?: string;
}

export interface LoopState {
  version: 1;
  runId: string;
  /** Stable owner session for presentation/recovery scoping. */
  sessionId?: string;
  requestedIssues: number;
  /** Requested issues not yet settled; deferred and blocked issues count as settled. */
  remainingIssues: number;
  step: number;
  /** Current bounded session transition (1..3) for controller status display. */
  sessionTransition?: number;
  sessionTransitionLimit?: number;
  settledStep: number;
  maxSteps: number;
  stepHead?: string;
  stepStartedAt?: string;
  completedIssues: number[];
  deferredIssues: DeferredIssue[];
  issueMetrics: LoopIssueMetrics[];
  status: LoopStatus;
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
  lastOutcome?: LoopOutcome;
  lastReason?: string;
  metrics: LoopMetrics;
  /** Present when the current worker boundary ended without a terminal result. */
  workerResultMissing?: boolean;
  /** Bounded durable recovery telemetry; optional for v1 state compatibility. */
  recovery?: LoopRecoveryState;
  /** Root coordination checkout and claimed issue execution identity. */
  coordinationCwd?: string;
  activeIssueNumber?: number;
  activeWorkspace?: string;
  activeLease?: Omit<IssueLease, "version"> & Partial<Pick<IssueLease, "version">>;
}

export interface LoopResult {
  runId: string;
  step: number;
  outcome: LoopOutcome;
  issueNumber?: number;
  reason?: string;
  writtenAt: string;
}

export const ZERO_USAGE: LoopUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

export function emptyLoopMetrics(): LoopMetrics {
  return {
    ...ZERO_USAGE,
    sessions: 0,
    prompts: 0,
    modelDurationMs: 0,
    telemetryUnavailable: 0,
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function sessionUsage(ctx: ExtensionCommandContext): LoopUsage {
  const usage = { ...ZERO_USAGE };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const raw = message.usage;
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    usage.input += finite(value.input);
    usage.output += finite(value.output);
    usage.cacheRead += finite(value.cacheRead);
    usage.cacheWrite += finite(value.cacheWrite);
    usage.totalTokens += finite(value.totalTokens);
    const cost = value.cost;
    if (cost && typeof cost === "object") {
      usage.cost += finite((cost as Record<string, unknown>).total);
    }
  }
  return usage;
}

export function usageDelta(after: LoopUsage, before: LoopUsage): LoopUsage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    cost: Math.max(0, after.cost - before.cost),
  };
}

export function addPromptMetrics(
  metrics: LoopMetrics | undefined,
  delta: LoopUsage,
  durationMs: number,
  newSession: boolean,
  telemetryAvailable = true,
): LoopMetrics {
  const current = { ...emptyLoopMetrics(), ...metrics };
  return {
    input: current.input + delta.input,
    output: current.output + delta.output,
    cacheRead: current.cacheRead + delta.cacheRead,
    cacheWrite: current.cacheWrite + delta.cacheWrite,
    totalTokens: current.totalTokens + delta.totalTokens,
    cost: current.cost + delta.cost,
    sessions: current.sessions + (newSession ? 1 : 0),
    prompts: current.prompts + 1,
    modelDurationMs: current.modelDurationMs + Math.max(0, durationMs),
    telemetryUnavailable: current.telemetryUnavailable + (telemetryAvailable ? 0 : 1),
  };
}

export function addIssuePromptMetrics(
  metrics: LoopIssueMetrics[] | undefined,
  issueNumber: number | undefined,
  delta: LoopUsage,
  durationMs: number,
  newSession: boolean,
  telemetryAvailable = true,
): LoopIssueMetrics[] {
  const current = [...(metrics || [])];
  if (!issueNumber || issueNumber <= 0) return current.slice(-MAX_ISSUE_METRICS);
  const index = current.findIndex((item) => item.issueNumber === issueNumber);
  const previous = index >= 0 ? current[index] : undefined;
  const aggregate = addPromptMetrics(previous, delta, durationMs, newSession, telemetryAvailable);
  const next: LoopIssueMetrics = {
    ...aggregate,
    issueNumber,
    disposition: previous?.disposition || "active",
    updatedAt: loopNow(),
    reason: previous?.reason,
  };
  if (index >= 0) current.splice(index, 1);
  current.push(next);
  return current.slice(-MAX_ISSUE_METRICS);
}

export function markIssueDisposition(
  metrics: LoopIssueMetrics[] | undefined,
  issueNumber: number,
  disposition: LoopIssueDisposition,
  reason?: string,
): LoopIssueMetrics[] {
  const current = [...(metrics || [])];
  const index = current.findIndex((item) => item.issueNumber === issueNumber);
  const previous = index >= 0 ? current[index] : undefined;
  const next: LoopIssueMetrics = {
    ...(previous || emptyLoopMetrics()),
    issueNumber,
    disposition,
    updatedAt: loopNow(),
    reason: reason?.trim() || previous?.reason,
  };
  if (index >= 0) current.splice(index, 1);
  current.push(next);
  return current.slice(-MAX_ISSUE_METRICS);
}

export function loopRuntimeDir(cwd: string, runId?: string): string {
  return runId
    ? join(runtimeDir(cwd), "pi-next-loops", runId)
    : runtimeDir(cwd);
}

/**
 * Resolve the one authoritative root for a run's durable controller state
 * (`state.json`/`result.json`/`controller.lock`), independent of whatever
 * `cwd` issue-local git/tool/model execution currently uses (#602). A claimed
 * issue run always records its true coordination root in
 * `LoopState.coordinationCwd`; callers that only have a bare `cwd` (a
 * pre-claim/legacy run, or the outer coordination-root command entry points
 * that never leave `cwd` pointed at a worktree) fall back to it unchanged.
 */
export function runtimeCwdFor(
  cwd: string,
  state: Pick<LoopState, "coordinationCwd">,
): string {
  return state.coordinationCwd || cwd;
}

export function loopStateFile(cwd: string, runId?: string): string {
  return join(loopRuntimeDir(cwd, runId), runId ? "state.json" : "pi-next-loop.json");
}

export function loopResultFile(cwd: string, runId?: string): string {
  return join(loopRuntimeDir(cwd, runId), runId ? "result.json" : "pi-next-loop-result.json");
}

function controllerLockFile(cwd: string, runId: string): string {
  return join(loopRuntimeDir(cwd, runId), "controller.lock");
}

export function loopNow(): string {
  return new Date().toISOString();
}

export function parseLoopLimit(args: string): number {
  const count = Number.parseInt(args.trim() || String(DEFAULT_LIMIT), 10);
  return Number.isFinite(count) && count > 0
    ? Math.min(count, MAX_ISSUES)
    : DEFAULT_LIMIT;
}

export function listLoopStates(cwd: string): LoopState[] {
  const root = join(runtimeDir(cwd), "pi-next-loops");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readLoopState(cwd, entry.name))
    .filter((state): state is LoopState => Boolean(state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readLoopState(cwd: string, runId?: string): LoopState | null {
  const path = loopStateFile(cwd, runId);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as LoopState;
    return {
      ...state,
      completedIssues: state.completedIssues || [],
      deferredIssues: state.deferredIssues || [],
      issueMetrics: state.issueMetrics || [],
      metrics: { ...emptyLoopMetrics(), ...state.metrics },
      recovery: state.recovery
        ? {
            missingLoopResults: Math.max(0, Math.trunc(state.recovery.missingLoopResults || 0)),
            automaticSettlements: Math.max(0, Math.trunc(state.recovery.automaticSettlements || 0)),
            automaticResumes: Math.max(0, Math.trunc(state.recovery.automaticResumes || 0)),
            exhausted: Math.max(0, Math.trunc(state.recovery.exhausted || 0)),
            attemptsByFingerprint: { ...(state.recovery.attemptsByFingerprint || {}) },
            retryLimit: state.recovery.retryLimit,
            lastFingerprint: state.recovery.lastFingerprint,
            lastRecoveryStep: state.recovery.lastRecoveryStep,
            lastRecoveryIssueNumber: state.recovery.lastRecoveryIssueNumber,
            lastOutcome: state.recovery.lastOutcome,
            lastReason: state.recovery.lastReason,
            updatedAt: state.recovery.updatedAt,
          }
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Persist one `pi_next_update(action="loop_result")` outcome to the
 * authoritative coordination runtime for `result.runId` (#603).
 *
 * `authorityCwd` must be the run's true coordination root — normally
 * `LoopState.coordinationCwd`, transported to the isolated child worker via
 * `PI_NEXT_COORDINATION_CWD` (see `IssueWorkerOptions.coordinationCwd` in
 * `util-core.ts`) — never derived from the worker's own issue-worktree
 * `ctx.cwd`. This makes result persistence independent of any worktree-local
 * `.pi/runtime` path: a missing, stale, or foreign worktree runtime tree can
 * neither absorb nor redirect the result.
 */
export function writeLoopResult(authorityCwd: string, result: LoopResult): string {
  const scopedState = readLoopState(authorityCwd, result.runId);
  const state = scopedState || readLoopState(authorityCwd);
  if (!state || state.status !== "running") {
    throw new Error("No running pi-next loop is waiting for a result");
  }
  if (result.runId !== state.runId || result.step !== state.step) {
    throw new Error(
      `Loop result does not match the active step (${state.runId}/${state.step})`,
    );
  }
  if (
    ["archived", "defer_issue", "block_issue"].includes(result.outcome) &&
    (!Number.isInteger(result.issueNumber) || (result.issueNumber || 0) <= 0)
  ) {
    throw new Error(`issueNumber is required for a ${result.outcome} loop step`);
  }
  if (["defer_issue", "block_issue"].includes(result.outcome) && !result.reason?.trim()) {
    throw new Error(`reason is required for a ${result.outcome} loop step`);
  }
  const path = loopResultFile(authorityCwd, scopedState ? result.runId : undefined);
  if (existsSync(path)) throw new Error("This loop step already has a recorded result");
  writeJsonAtomic(path, result);
  return path;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireControllerLock(cwd: string, runId: string): () => void {
  // Guarantee the complete run-scoped parent directory exists before
  // exclusive lock creation (#602): a fresh run must not depend on
  // state.json or another side effect having created
  // pi-next-loops/<runId>/ first, or openSync(path, "wx") throws ENOENT.
  mkdirSync(loopRuntimeDir(cwd, runId), { recursive: true });
  const path = controllerLockFile(cwd, runId);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const pid = Number.parseInt(existing.match(/^pid=(\d+)$/m)?.[1] || "0", 10);
    if (processAlive(pid)) {
      throw new Error(`Another pi-next loop controller is active (pid ${pid})`);
    }
    unlinkSync(path);
  }
  const fd = openSync(path, "wx");
  writeFileSync(
    fd,
    `pid=${process.pid}\nrun_id=${runId}\nstarted=${loopNow()}\n`,
    "utf8",
  );
  closeSync(fd);
  return () => removeFile(path);
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

function formatIssueMetric(metric: LoopIssueMetrics): string {
  const duration = (metric.modelDurationMs / 60_000).toFixed(1);
  return `#${metric.issueNumber}:${metric.disposition} p=${metric.prompts} s=${metric.sessions} tok=${formatCount(metric.totalTokens)} min=${duration}`;
}

export function safeLoopNotify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  try {
    const identity = piNextRuntimeIdentity();
    void Promise.resolve(
      ctx.ui.notify(`Pi-next version=${identity.version}\n${message}`, level),
    ).catch(() => undefined);
  } catch {
    // The host can tear down the UI while an unattended loop is unwinding.
    // Notifications are diagnostic only and must never become an unhandled
    // rejection that takes down the extension host.
  }
}

export function notifyLoopState(
  ctx: ExtensionCommandContext,
  state: LoopState | null,
): void {
  if (!state) {
    safeLoopNotify(ctx, "No durable pi-next loop state found.", "info");
    return;
  }
  const completed = state.completedIssues.length
    ? state.completedIssues.map((issue) => `#${issue}`).join(", ")
    : "none";
  const deferred = state.deferredIssues.length
    ? state.deferredIssues.map((item) => `#${item.issueNumber}`).join(", ")
    : "none";
  const metrics = state.metrics || emptyLoopMetrics();
  const issueCount = state.completedIssues.length;
  const sessionsPerIssue = issueCount ? (metrics.sessions / issueCount).toFixed(1) : "-";
  const tokensPerIssue = issueCount ? formatCount(metrics.totalTokens / issueCount) : "-";
  const cacheDenominator = metrics.input + metrics.cacheRead;
  const cacheRate = cacheDenominator
    ? `${Math.round((metrics.cacheRead / cacheDenominator) * 100)}%`
    : "-";
  const elapsedMs = Math.max(0, Date.now() - Date.parse(state.createdAt));
  const elapsedMinutes = (elapsedMs / 60_000).toFixed(1);
  const cost = metrics.cost > 0 ? ` cost=$${metrics.cost.toFixed(4)}` : "";
  const recent = (state.issueMetrics || []).slice(-5).map(formatIssueMetric).join("; ");
  const recovery = state.recovery
    ? `\nRecovery: missing_results=${state.recovery.missingLoopResults} resumes=${state.recovery.automaticResumes} settlements=${state.recovery.automaticSettlements} exhausted=${state.recovery.exhausted}${state.recovery.lastOutcome ? ` outcome=${state.recovery.lastOutcome}` : ""}`
    : "";
  safeLoopNotify(
    ctx,
    `Pi loop ${state.status}: step=${state.step}/${state.maxSteps} issues_remaining=${state.remainingIssues} completed=${completed} deferred=${deferred}\nTelemetry: sessions=${metrics.sessions} prompts=${metrics.prompts} sessions/issue=${sessionsPerIssue} tokens=${formatCount(metrics.totalTokens)} tokens/issue=${tokensPerIssue} cache_read=${formatCount(metrics.cacheRead)} cache_rate=${cacheRate} model_min=${(metrics.modelDurationMs / 60_000).toFixed(1)} elapsed_min=${elapsedMinutes}${cost}${recovery}${recent ? `\nRecent issues: ${recent}` : ""}${state.lastReason ? `\nReason: ${state.lastReason}` : ""}`,
    ["failed", "blocked", "interrupted"].includes(state.status)
      ? "warning"
      : "info",
  );
}

export function archivedIssueNumberFromCommitSubject(
  subject: string,
): number | undefined {
  const match = subject.trim().match(/^chore\(agent\): archive issue #(\d+) plan$/);
  if (!match) return undefined;
  const issue = Number.parseInt(match[1], 10);
  return Number.isInteger(issue) && issue > 0 ? issue : undefined;
}

async function archivedIssueClosureBoundary(
  cwd: string,
): Promise<{ safe: boolean; reason?: string }> {
  const subject = await git(cwd, ["log", "-1", "--format=%s"]);
  const issue = archivedIssueNumberFromCommitSubject(subject);
  if (!issue) return { safe: true };

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(issue), "--json", "state"],
      { cwd, maxBuffer: 256 * 1024 },
    );
    const state = String(
      (JSON.parse(stdout) as Record<string, unknown>).state || "",
    ).toUpperCase();
    if (state === "CLOSED") {
      // fall through to the archive-commit reachability check below
    } else {
      return {
        safe: false,
        reason: `GitHub issue #${issue} remains ${state || "open/unverified"} after local archive; update/close the issue, then retry the same archived loop result`,
      };
    }
  } catch {
    return {
      safe: false,
      reason: `Cannot verify GitHub issue #${issue} is closed after local archive; synchronize GitHub issue completion, then retry the same archived loop result`,
    };
  }

  try {
    const archiveSha = await git(cwd, ["rev-parse", "HEAD"]);
    const verifyPath = verifyFile(cwd);
    const evidenceShas = existsSync(verifyPath)
      ? extractCommitEvidenceShas(readFileSync(verifyPath, "utf8"))
      : [];
    const candidates = [...new Set([archiveSha, ...evidenceShas])];
    await git(cwd, ["fetch", "origin", "main"]);
    const { unreachable, unreachableDetails } = await commitsReachableFromRef(
      cwd,
      candidates,
      "origin/main",
    );
    if (unreachable.length) {
      return {
        safe: false,
        reason: `Commit evidence for issue #${issue} is not reachable from origin/main:\n${formatUnreachableCommitDetails(unreachableDetails)}`,
      };
    }
  } catch {
    return {
      safe: false,
      reason: `Cannot verify the archive commit or cited evidence commits for issue #${issue} are reachable from origin/main; synchronize the commits, then retry the same archived loop result`,
    };
  }

  return { safe: true };
}

export async function safeLoopBoundary(
  cwd: string,
  requireNoPlan: boolean,
): Promise<{ safe: boolean; reason?: string }> {
  const changed = await changeFiles(cwd, "all");
  if (changed.length) {
    return { safe: false, reason: `Dirty worktree after step: ${changed.join(", ")}` };
  }
  if (existsSync(markerFile(cwd))) {
    return { safe: false, reason: "Continuation marker remains after step" };
  }
  if (requireNoPlan && existsSync(planFile(cwd))) {
    return { safe: false, reason: "PLAN.md remains after an archived/deferred step" };
  }
  if (requireNoPlan) {
    const remote = await archivedIssueClosureBoundary(cwd);
    if (!remote.safe) return remote;
  }
  return { safe: true };
}

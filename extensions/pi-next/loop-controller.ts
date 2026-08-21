import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  pendingPlanRepair,
  validateCanonicalExecutionState,
  validateWorkspacePlan,
} from "./execution-boundary.ts";
import { checkIssueFreshness, primeIssueFreshness } from "./issue-freshness.ts";
import { isIssueLeaseFresh, issueLeaseMatchesOwner, issueWorkspaceIdentity } from "./issue-authority.ts";
import { candidateShortlist } from "./issue-candidates.ts";
import { attachWorkerDisplay, type WorkerDisplayController } from "./worker-display.ts";
import {
  GitHubIssueLeaseAuthority,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import {
  createSupervisorRuntime,
  type SupervisorRuntime,
} from "./supervisor-runtime.ts";
import {
  issueBoundaryMaintenanceDecision,
  maintenanceOwed,
  runIssueBoundaryMaintenance,
} from "./loop-maintenance.ts";
import { currentTask, section } from "./plan.ts";
import { buildLoopPrompt } from "./prompt.ts";
import {
  PlanAuthorityError,
  safeNotify,
  resolvePlanIdentity,
  runIssueWorker,
  type IssueWorkerOptions,
  type WorkerWatchdogEvent,
  type IssueWorkerRunner,
} from "./util-core.ts";
import {
  changeFiles,
  git,
  isWorkflowMetaPath,
  planFile,
  removeFile,
  workflowPath,
  writeJsonAtomic,
} from "./util.ts";
import {
  acquireControllerLock,
  addIssuePromptMetrics,
  addPromptMetrics,
  initializeIssueBudgetBaseline,
  loopNow,
  loopResultFile,
  loopStateFile,
  markIssueDisposition,
  markIssueTransition,
  recordIssueTransitionResult,
  notifyLoopState,
  readLoopState,
  runtimeCwdFor,
  safeLoopBoundary,
  ZERO_USAGE,
  type LoopOutcome,
  type LoopResult,
  type LoopState,
  type LoopStatus,
} from "./loop-state.ts";
import type { WorkerTelemetryReport } from "./worker-telemetry.ts";
import { createWorkerDispatch } from "../../src/coordination/worker-dispatch.ts";
import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { feedbackFingerprint } from "../../src/coordination/feedback.ts";
import { isTransientAuthorityReadFailure } from "../../src/coordination/authority-read-policy.ts";
import { observeManagedTransition } from "./self-assessment.ts";
import { recentLifecycleEventNames, recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { reportRuntimeFailure, reportWorkerToolFailures } from "./feedback-runtime.ts";
import {
  createWorkerFailureEvidence,
  WorkerFailureError,
} from "./worker-failure.ts";
import { classifyFailure, IssueBoundaryFailure } from "./failure-scope.ts";
import {
  memoryPressureReason,
  observeHostMemory,
  type HostMemoryBoundaryContext,
} from "./host-memory.ts";

/** Bounded child-worker turns per controller batch; never a host-session limit. */
export const MAX_WORKER_TRANSITIONS_PER_BATCH = 3;
/** Maximum fresh workers for one normalized missing-result failure. */
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;
/** Maximum planning-only attempts for one unchanged malformed PLAN. */
export const DEFAULT_MAX_PLAN_REPAIR_ATTEMPTS = 2;

/**
 * Kept as a controller export for existing integrations; the policy itself is
 * shared with harness-neutral worktree recovery.
 */
export { isTransientAuthorityReadFailure } from "../../src/coordination/authority-read-policy.ts";

export type MissingLoopResultRecoveryOutcome =
  | "none"
  | "settled_from_durable_evidence"
  | "resuming_same_issue"
  | "recovery_unsafe"
  | "recovery_exhausted";

export interface MissingLoopResultRecovery {
  outcome: MissingLoopResultRecoveryOutcome;
  state: LoopState;
  reason?: string;
  fingerprint?: string;
}

// Worker-generation lifecycle is injected from the owning
// ForegroundSupervisor runtime (#612). This controller only drives one
// bounded worker-turn state machine and never owns process-global lifecycle
// state, so concurrent supervisors retain independent cancellation signals.

interface StepSettlement {
  state: LoopState;
  terminal: boolean;
  outcome?: LoopOutcome;
}

/**
 * Record a payload-free parent-host memory boundary and persist only the
 * compact decision needed for restart/recovery. The detailed bounded sample
 * ring lives in the runtime diagnostics file, never in loop state.
 */
export function observeLoopHostMemory(
  cwd: string,
  state: LoopState,
  context: Omit<HostMemoryBoundaryContext, "runId"> & { boundary: string },
): LoopState {
  const runtimeCwd = runtimeCwdFor(cwd, state);
  const observed = observeHostMemory(runtimeCwd, {
    ...context,
    runId: state.runId,
    issueNumber: context.issueNumber ?? state.activeIssueNumber,
    step: context.step ?? state.step,
    workerBatchTransition: context.workerBatchTransition ?? state.workerBatchTransition ?? context.sessionTransition ?? state.sessionTransition,
  });
  const hostMemory: LoopState["hostMemory"] = {
    status: observed.health.restartRequired ? "restart_required" : observed.health.pressure,
    heapUsed: observed.sample.heapUsed,
    heapLimit: observed.sample.heapLimit,
    heapUsedDelta: observed.sample.heapUsedDelta,
    criticalStreak: observed.health.criticalStreak,
    observedAt: observed.sample.at,
    boundary: observed.sample.boundary,
    ...(observed.health.restartRequired ? { reason: memoryPressureReason(observed.health) } : {}),
  };
  const next: LoopState = {
    ...state,
    hostMemory,
    ...(observed.health.restartRequired
      ? {
          status: "stopped" as const,
          updatedAt: loopNow(),
          lastReason: memoryPressureReason(observed.health),
        }
      : {}),
  };
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), next);
  return next;
}

interface ApplyResultOptions {
  /** A planning repair may preserve pre-existing issue-local dirt. */
  allowDirtyPlanRepair?: boolean;
}

type PlanRepairDirtySnapshot = Map<string, string>;

async function planRepairPathFingerprint(cwd: string, path: string): Promise<string> {
  const absolute = join(cwd, path);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(absolute)}`;
    if (stat.isFile()) {
      // Let Git stream the content into its object hash instead of retaining a
      // potentially large dirty product file in the controller heap.
      const hash = (await git(cwd, ["hash-object", "--no-filters", "--", path])).trim();
      return `file:${stat.mode}:${hash}`;
    }
    return `other:${stat.mode}:${stat.size}`;
  } catch {
    return "missing";
  }
}

async function snapshotPlanRepairDirtyState(cwd: string): Promise<PlanRepairDirtySnapshot> {
  const paths = await changeFiles(cwd, "all");
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    const status = (await git(cwd, ["status", "--porcelain=v1", "--", path])).trim();
    snapshot.set(path, `${status}\0${await planRepairPathFingerprint(cwd, path)}`);
  }
  return snapshot;
}

async function validatePlanRepairDirtyState(
  cwd: string,
  before: PlanRepairDirtySnapshot,
): Promise<{ safe: boolean; workflowDirty: boolean; reason?: string }> {
  const after = await changeFiles(cwd, "all");
  const violations: string[] = [];
  for (const path of after) {
    if (isWorkflowMetaPath(path, cwd)) continue;
    const current = `${(await git(cwd, ["status", "--porcelain=v1", "--", path])).trim()}\0${await planRepairPathFingerprint(cwd, path)}`;
    if (before.get(path) !== current) violations.push(path);
  }
  const workflowDirty = after.some((path) => isWorkflowMetaPath(path, cwd));
  if (violations.length) {
    return {
      safe: false,
      workflowDirty,
      reason: `Planning repair changed product paths: ${violations.join(", ")}`,
    };
  }
  return { safe: true, workflowDirty };
}

export type WorkerObserver = Pick<IssueWorkerOptions, "onActivity" | "onWorkerState"> & {
  display?: WorkerDisplayController;
};

function currentPlanIssue(cwd: string): number | undefined {
  const plan = resolvePlanIdentity(cwd);
  return plan.kind === "resolved" ? plan.issueNumber : undefined;
}

function pendingResultIssue(cwd: string, runId: string): number | undefined {
  const path = loopResultFile(cwd, runId);
  if (!existsSync(path)) return undefined;
  try {
    const result = JSON.parse(readFileSync(path, "utf8")) as LoopResult;
    return result.issueNumber && result.issueNumber > 0
      ? Math.floor(result.issueNumber)
      : undefined;
  } catch {
    return undefined;
  }
}

function issueForTelemetry(
  cwd: string,
  runtimeCwd: string,
  runId: string,
): number | undefined {
  return currentPlanIssue(cwd) || pendingResultIssue(runtimeCwd, runId);
}

function planTaskCounts(cwd: string): { total: number; remaining: number } {
  const file = planFile(cwd);
  if (!existsSync(file)) return { total: 0, remaining: 0 };
  const tasks = section(readFileSync(file, "utf8"), "## Tasks").split(/\r?\n/);
  const topLevel = tasks.filter((line) => /^- \[[ xX]\] /.test(line));
  return {
    total: topLevel.length,
    remaining: topLevel.filter((line) => /^- \[ \] /.test(line)).length,
  };
}

export function issueBudgetDecision(
  metric: import("./loop-state.ts").LoopIssueMetrics | undefined,
  policy: ReturnType<typeof loadPiNextConfig>["convergence"],
): { soft: boolean; hard: boolean; percent: number; reason: string; tokenUsage: number; tokenBaseline: number } {
  if (!metric) return { soft: false, hard: false, percent: 0, reason: "no issue budget recorded yet", tokenUsage: 0, tokenBaseline: 0 };
  // Missing baselines are treated as activating now for legacy callers too;
  // runOneStep persists the explicit baseline before it can yield.
  const tokenBaseline = Math.max(0, metric.budgetBaselineTokens ?? metric.totalTokens);
  const tokenUsage = Math.max(0, metric.totalTokens - tokenBaseline);
  const transitions = Math.max(0, (metric.transitions || 0) - (metric.budgetBaselineTransitions || 0));
  const wallClockMs = Math.max(0, (metric.wallClockMs || 0) - (metric.budgetBaselineWallClockMs || 0));
  const ratios = [
    transitions / policy.hardTransitions,
    wallClockMs / policy.hardWallMs,
    tokenUsage / policy.hardTokens,
  ];
  const percent = Math.min(1, Math.max(0, Math.max(...ratios)));
  const hardReasons = [
    transitions >= policy.hardTransitions ? `${transitions} transitions` : "",
    wallClockMs >= policy.hardWallMs ? `${Math.round(wallClockMs / 60_000)}m wall time` : "",
    tokenUsage >= policy.hardTokens ? `${tokenUsage} tokens (baseline ${tokenBaseline})` : "",
  ].filter(Boolean);
  const softReasons = [
    transitions >= policy.softTransitions ? `${transitions} transitions` : "",
    wallClockMs >= policy.softWallMs ? `${Math.round(wallClockMs / 60_000)}m wall time` : "",
    tokenUsage >= policy.softTokens ? `${tokenUsage} tokens (baseline ${tokenBaseline})` : "",
  ].filter(Boolean);
  return {
    soft: softReasons.length > 0,
    hard: hardReasons.length > 0,
    percent,
    reason: hardReasons.length ? hardReasons.join(", ") : softReasons.join(", "),
    tokenUsage,
    tokenBaseline,
  };
}

function planNeedsFinalLifecycle(cwd: string): boolean {
  const file = planFile(cwd);
  if (!existsSync(file)) return false;
  return currentTask(readFileSync(file, "utf8")) === null;
}

async function parkDeferredPlan(
  cwd: string,
  issueNumber: number,
): Promise<string | undefined> {
  if (!existsSync(planFile(cwd))) return undefined;
  const planIssue = currentPlanIssue(cwd);
  if (planIssue !== issueNumber) {
    throw new Error(
      `Cannot defer issue #${issueNumber}: active PLAN.md belongs to #${planIssue || "unknown"}`,
    );
  }
  const before = await safeLoopBoundary(cwd, false);
  if (!before.safe) {
    throw new Error(
      `Cannot park deferred plan from unsafe state: ${before.reason}`,
    );
  }

  const deferredDirectory = workflowPath(cwd, "deferredDir");
  mkdirSync(deferredDirectory, { recursive: true });
  const target = join(deferredDirectory, `issue-${issueNumber}.md`);
  await git(cwd, [
    "mv",
    "-f",
    "--",
    relative(cwd, planFile(cwd)),
    relative(cwd, target),
  ]);
  await git(cwd, [
    "commit",
    "-m",
    `chore(agent): defer issue #${issueNumber} plan`,
  ]);

  const after = await safeLoopBoundary(cwd, true);
  if (!after.safe) {
    throw new Error(
      `Deferred plan commit did not leave a safe boundary: ${after.reason}`,
    );
  }
  return target;
}

async function blockForNoProgress(
  cwd: string,
  state: LoopState,
  result: LoopResult,
): Promise<never> {
  const issue = state.activeIssueNumber;
  const reason = `Step reported ${result.outcome} without advancing HEAD; refusing a no-op unattended retry`;
  // A no-op is evidence about this worker turn, not automatically about the
  // controller. Preserve the diagnostic before handing it to the normal
  // issue-local containment path, which releases only this issue and lets the
  // supervisor select another candidate.
  if (!issue || (result.issueNumber !== undefined && result.issueNumber !== issue)) {
    throw new Error(`${reason}; active issue identity is missing or mismatched`);
  }
  const diagnostic: LoopState = {
    ...state,
    status: "running",
    updatedAt: loopNow(),
    lastOutcome: result.outcome,
    lastReason: reason,
  };
  const runtimeCwd = runtimeCwdFor(cwd, state);
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), diagnostic);
  removeFile(loopResultFile(runtimeCwd, state.runId));
  throw new IssueBoundaryFailure(issue, "execution", reason);
}

async function applyResult(
  cwd: string,
  state: LoopState,
  result: LoopResult,
  options: ApplyResultOptions = {},
): Promise<StepSettlement> {
  const runtimeCwd = runtimeCwdFor(cwd, state);
  if (result.schedulerOnly && result.outcome === "yield_issue" && result.step === state.step) {
    const issue = result.issueNumber as number;
    if (!Number.isSafeInteger(issue) || issue < 1 || !result.reason?.trim()) {
      throw new Error("scheduler-only yield requires an issue number and reason");
    }
    const yieldedAt = loopNow();
    const yielded: LoopState = {
      ...state,
      deferredIssues: [
        ...state.deferredIssues.filter((item) => item.issueNumber !== issue),
        { issueNumber: issue, reason: result.reason.trim(), deferredAt: yieldedAt, kind: "yielded" },
      ],
      issueMetrics: markIssueDisposition(state.issueMetrics, issue, "yielded", result.reason),
      updatedAt: yieldedAt,
      lastOutcome: "yield_issue",
      lastReason: result.reason.trim(),
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), yielded);
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return { state: yielded, terminal: false, outcome: result.outcome };
  }
  if (result.step <= state.settledStep) {
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return {
      state,
      terminal: state.status !== "running",
      outcome: result.outcome,
    };
  }
  if (result.runId !== state.runId || result.step !== state.step) {
    const failed: LoopState = {
      ...state,
      status: "failed",
      settledStep: state.step,
      updatedAt: loopNow(),
      lastReason: "Step result did not match the active controller state",
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), failed);
    return { state: failed, terminal: true, outcome: "failed" };
  }

  if (result.outcome === "yield_issue") {
    const issue = result.issueNumber as number;
    if (!Number.isSafeInteger(issue) || issue < 1 || !result.reason?.trim()) {
      const failed: LoopState = {
        ...state,
        status: "failed",
        settledStep: state.step,
        updatedAt: loopNow(),
        lastOutcome: result.outcome,
        lastReason: "yield_issue requires an issue number and authoritative reason",
      };
      writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), failed);
      return { state: failed, terminal: true, outcome: "failed" };
    }
    // Authority ineligibility is a non-destructive scheduler boundary. Do not
    // park/remove PLAN.md or require a clean worktree: safe dirty work must
    // remain available when the issue becomes eligible again.
    const yieldedAt = loopNow();
    const yielded: LoopState = {
      ...state,
      workerResultMissing: undefined,
      settledStep: state.step,
      deferredIssues: [
        ...state.deferredIssues.filter((item) => item.issueNumber !== issue),
        { issueNumber: issue, reason: result.reason.trim(), deferredAt: yieldedAt, kind: "yielded" },
      ],
      issueMetrics: markIssueDisposition(state.issueMetrics, issue, "yielded", result.reason),
      updatedAt: yieldedAt,
      lastOutcome: result.outcome,
      lastReason: `Yielded issue #${issue}: ${result.reason.trim()}`,
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), yielded);
    if (/issue convergence budget exhausted/i.test(result.reason || "")) {
      recordLifecycleEvent(runtimeCwd, {
        event: "issue_budget_yielded",
        issueNumber: issue,
        runId: state.runId,
        outcome: "recovered",
        reasonCode: "issue_convergence_budget_exhausted",
      });
    }
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return { state: yielded, terminal: false, outcome: result.outcome };
  }

  if (
    [
      "continue",
      "done",
      "archived",
      "defer_issue",
      "block_issue",
      "blocked",
      "idle",
    ].includes(result.outcome)
  ) {
    const boundary = await safeLoopBoundary(cwd, result.outcome === "archived");
    const dirtyPlanRepairBoundary = options.allowDirtyPlanRepair &&
      result.outcome === "continue" &&
      !boundary.safe &&
      boundary.reason?.startsWith("Dirty worktree after step:");
    if (!boundary.safe && !dirtyPlanRepairBoundary) {
      removeFile(loopResultFile(runtimeCwd, state.runId));
      throw new IssueBoundaryFailure(
        result.issueNumber || state.activeIssueNumber || 0,
        "execution",
        boundary.reason || "issue workspace did not reach a safe boundary",
      );
    }
  }

  if (["continue", "done", "archived"].includes(result.outcome)) {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const repairStillPending = state.planRepair && state.activeIssueNumber
      ? Boolean(pendingPlanRepair(cwd, state.activeIssueNumber))
      : false;
    if (!state.stepHead || head === state.stepHead) {
      if (!(options.allowDirtyPlanRepair && result.outcome === "continue" && repairStillPending)) {
        return blockForNoProgress(cwd, state, result);
      }
    }
  }

  if (result.outcome === "archived") {
    const issue = result.issueNumber as number;
    const completed: LoopState = {
      ...state,
      workerResultMissing: undefined,
      remainingIssues: state.remainingIssues - 1,
      settledStep: state.step,
      completedIssues: [...new Set([...state.completedIssues, issue])],
      issueMetrics: markIssueDisposition(
        state.issueMetrics,
        issue,
        "completed",
        result.reason,
      ),
      updatedAt: loopNow(),
      lastOutcome: result.outcome,
      lastReason: result.reason,
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), completed);
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return { state: completed, terminal: false, outcome: result.outcome };
  }

  if (result.outcome === "defer_issue" || result.outcome === "block_issue") {
    const issue = result.issueNumber as number;
    if (!result.reason?.trim()) {
      const failed: LoopState = {
        ...state,
        status: "failed",
        settledStep: state.step,
        updatedAt: loopNow(),
        lastOutcome: result.outcome,
        lastReason: `${result.outcome} requires a concrete issue-local blocker reason`,
      };
      writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), failed);
      removeFile(loopResultFile(runtimeCwd, state.runId));
      return { state: failed, terminal: true, outcome: "failed" };
    }
    const parkedPlan = await parkDeferredPlan(cwd, issue);
    const deferredAt = loopNow();
    const deferred: LoopState = {
      ...state,
      workerResultMissing: undefined,
      // Deferred and blocked issues are settled for this bounded run. Keeping
      // remainingIssues aligned with the durable disposition makes queue
      // progress truthful and prevents a run of only deferred issues from
      // consuming its entire step budget.
      remainingIssues: Math.max(0, state.remainingIssues - 1),
      settledStep: state.step,
      deferredIssues: [
        ...state.deferredIssues.filter((item) => item.issueNumber !== issue),
        {
          issueNumber: issue,
          reason: result.reason.trim(),
          deferredAt,
          kind: result.outcome === "block_issue" ? "blocked" : "deferred",
          parkedPlan,
        },
      ],
      issueMetrics: markIssueDisposition(
        state.issueMetrics,
        issue,
        result.outcome === "block_issue" ? "blocked" : "deferred",
        result.reason,
      ),
      updatedAt: deferredAt,
      lastOutcome: result.outcome,
      lastReason: `Deferred issue #${issue}: ${result.reason.trim()}`,
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), deferred);
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return { state: deferred, terminal: false, outcome: result.outcome };
  }

  if (result.outcome === "continue" || result.outcome === "done") {
    const continuing: LoopState = {
      ...state,
      workerResultMissing: undefined,
      settledStep: state.step,
      updatedAt: loopNow(),
      lastOutcome: result.outcome,
      lastReason: result.reason,
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), continuing);
    removeFile(loopResultFile(runtimeCwd, state.runId));
    return { state: continuing, terminal: false, outcome: result.outcome };
  }

  const terminalStatus: LoopStatus =
    result.outcome === "idle" ? "idle" : result.outcome;
  const terminal: LoopState = {
    ...state,
    workerResultMissing: undefined,
    status: terminalStatus,
    settledStep: state.step,
    updatedAt: loopNow(),
    lastOutcome: result.outcome,
    lastReason: result.reason,
  };
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), terminal);
  removeFile(loopResultFile(runtimeCwd, state.runId));
  return { state: terminal, terminal: true, outcome: result.outcome };
}

export async function inferCompletedArchive(
  cwd: string,
  state: LoopState,
): Promise<LoopResult | null> {
  if (state.step <= state.settledStep || existsSync(planFile(cwd))) return null;
  const boundary = await safeLoopBoundary(cwd, true);
  if (!boundary.safe) return null;
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (!state.stepHead || head === state.stepHead) return null;
  const subject = await git(cwd, ["log", "-1", "--format=%s"]);
  const match = subject.match(/^chore\(agent\): archive issue #(\d+) plan$/);
  if (!match) return null;
  return {
    runId: state.runId,
    step: state.step,
    outcome: "archived",
    issueNumber: Number.parseInt(match[1], 10),
    reason: "Recovered archived step from its clean archive commit",
    writtenAt: loopNow(),
  };
}

async function settleStep(
  cwd: string,
  state: LoopState,
  options: ApplyResultOptions = {},
): Promise<StepSettlement> {
  if (state.step <= state.settledStep) {
    return { state, terminal: state.status !== "running" };
  }
  const runtimeCwd = runtimeCwdFor(cwd, state);
  if (existsSync(loopResultFile(runtimeCwd, state.runId))) {
    const result = JSON.parse(
      readFileSync(loopResultFile(runtimeCwd, state.runId), "utf8"),
    ) as LoopResult;
    return applyResult(cwd, state, result, options);
  }
  const inferred = await inferCompletedArchive(cwd, state);
  if (inferred) return applyResult(cwd, state, inferred, options);

  const interrupted: LoopState = {
    ...state,
    status: "interrupted",
    workerResultMissing: true,
    updatedAt: loopNow(),
    lastReason:
      "Session ended without pi_next_update(action=loop_result); automatic reconciliation is inspecting the current issue",
  };
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), interrupted);
  return { state: interrupted, terminal: true, outcome: "failed" };
}

/**
 * Reconcile a worker boundary that has no authoritative loop_result. This is
 * deliberately outside the model prompt: only durable archive evidence,
 * current lease ownership, canonical worktree identity, and git state can
 * authorize recovery. In particular, dirty issue-local files are preserved;
 * they are not evidence of completion and are never reset or stashed.
 */
export interface MissingLoopResultRecoveryOptions {
  maxAttempts?: number;
  maxTotalAttempts?: number;
  /** Bounded deterministic controller activity; delivery is presentation-only. */
  onActivity?: (summary: string) => void;
}

export async function reconcileMissingLoopResult(
  coordinationCwd: string,
  state: LoopState,
  authority: Pick<IssueLeaseAuthority, "read"> = new GitHubIssueLeaseAuthority(coordinationCwd),
  options: MissingLoopResultRecoveryOptions = {},
): Promise<MissingLoopResultRecovery> {
  if (!state.workerResultMissing || state.step <= state.settledStep) {
    return { outcome: "none", state };
  }

  const issueNumber = state.activeIssueNumber;
  const activity = (summary: string): void => {
    try {
      options.onActivity?.(summary.slice(0, 180));
    } catch {
      // Display delivery is diagnostic only and cannot affect recovery.
    }
  };
  const previous = state.recovery || {
    missingLoopResults: 0,
    automaticSettlements: 0,
    automaticResumes: 0,
    exhausted: 0,
    attemptsByFingerprint: {},
  };
  // Keep the first normalized boundary fingerprint across same-issue retry
  // steps. lastReason becomes a recovery message after the first attempt;
  // using it as the next fingerprint would reset the retry budget forever,
  // while reusing a previous issue's fingerprint would couple their budgets.
  const sameIssueRecovery = previous.lastRecoveryIssueNumber === issueNumber;
  const fingerprint = sameIssueRecovery && previous.lastFingerprint
    ? previous.lastFingerprint
    : feedbackFingerprint({
      harness: "pi-next",
      stage: "worker-boundary",
      category: "runtime",
      code: "worker_result_missing",
      summary: state.lastReason || "worker exited without loop_result",
    });
  const attempts = previous.attemptsByFingerprint[fingerprint] || 0;
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS));
  const baseRecovery = {
    ...previous,
    missingLoopResults: previous.missingLoopResults + 1,
    lastFingerprint: fingerprint,
    lastRecoveryStep: state.step,
    lastRecoveryIssueNumber: issueNumber,
    retryLimit: maxAttempts,
    lastOutcome: "reconciling" as const,
    updatedAt: loopNow(),
  };
  activity(`reconciling missing worker result · attempt ${attempts + 1}/${maxAttempts}`);
  // Persist the reconciliation phase before any authority or git inspection;
  // a controller crash during inspection remains observable and is never
  // mistaken for a cleanly settled transition.
  writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), {
    ...state,
    recovery: baseRecovery,
    updatedAt: loopNow(),
  });
  recordLifecycleEvent(coordinationCwd, {
    event: "worker_recovery",
    issueNumber: issueNumber || 0,
    runId: state.runId,
    outcome: "skip",
    reasonCode: "worker_result_missing_reconciling",
  });

  const unsafe = async (
    reason: string,
    exhausted = false,
    consumedAttempts = attempts,
  ): Promise<MissingLoopResultRecovery> => {
    activity(exhausted ? "recovery exhausted" : "recovery unsafe");
    const attemptsByFingerprint = consumedAttempts > attempts
      ? { ...previous.attemptsByFingerprint, [fingerprint]: consumedAttempts }
      : previous.attemptsByFingerprint;
    const recovery = {
      ...baseRecovery,
      attemptsByFingerprint,
      exhausted: previous.exhausted + (exhausted ? 1 : 0),
      lastOutcome: exhausted ? "recovery_exhausted" as const : "recovery_unsafe" as const,
      lastReason: reason,
    };
    const blocked: LoopState = {
      ...state,
      status: "blocked",
      recovery,
      updatedAt: loopNow(),
      lastReason: reason,
    };
    writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), blocked);
    recordLifecycleEvent(coordinationCwd, {
      event: "worker_recovery",
      issueNumber: issueNumber || 0,
      runId: state.runId,
      outcome: "failure",
      reasonCode: exhausted ? "recovery_exhausted" : "recovery_unsafe",
    });
    await reportRuntimeFailure(coordinationCwd, {
      stage: "worker-recovery",
      category: exhausted ? "runtime" : "integrity",
      severity: exhausted ? "error" : "fatal",
      outcome: "failed",
      code: exhausted ? "worker_recovery_exhausted" : "worker_recovery_unsafe",
      summary: reason,
      issueNumber,
      runId: state.runId,
    });
    return { outcome: exhausted ? "recovery_exhausted" : "recovery_unsafe", state: blocked, reason, fingerprint };
  };

  if (!Number.isSafeInteger(issueNumber) || (issueNumber || 0) < 1 || !state.activeLease) {
    activity("recovery invariant failed · issue identity or lease missing");
    return unsafe("Cannot recover missing loop_result: active issue identity or lease is missing");
  }
  const issue = issueNumber as number;
  const identity = issueWorkspaceIdentity(issue);
  const workspace = resolve(coordinationCwd, identity.worktree);
  if (state.activeWorkspace !== workspace || !existsSync(workspace)) {
    activity("validating canonical worktree · unavailable or ambiguous");
    return unsafe(`Cannot recover issue #${issueNumber}: canonical issue worktree is missing or ambiguous`);
  }
  activity("validating canonical worktree");

  let liveLease;
  let authorityReadAttempts = 0;
  const authorityReadBudget = Math.max(1, maxAttempts - attempts);
  while (authorityReadAttempts < authorityReadBudget) {
    authorityReadAttempts += 1;
    activity(authorityReadAttempts === 1
      ? "reading authoritative issue lease"
      : `retrying authoritative lease read · attempt ${attempts + authorityReadAttempts}/${maxAttempts}`);
    try {
      liveLease = await authority.read(issue);
      activity("authoritative issue lease confirmed");
      break;
    } catch (error) {
      if (!isTransientAuthorityReadFailure(error)) {
        return unsafe(`Cannot reconcile issue #${issueNumber} lease before recovery: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (authorityReadAttempts < authorityReadBudget) {
        activity(`authority read transient · retry ${attempts + authorityReadAttempts}/${maxAttempts}`);
      }
      if (authorityReadAttempts >= authorityReadBudget) {
        return unsafe(
          `Transient authority read failed while reconciling issue #${issueNumber} after ${authorityReadAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
          true,
          attempts + authorityReadAttempts,
        );
      }
    }
  }
  if (!liveLease || !isIssueLeaseFresh(liveLease) || !issueLeaseMatchesOwner(liveLease, state.activeLease)) {
    activity("recovery unsafe · authoritative lease is missing, stale, or foreign");
    return unsafe(`Cannot recover issue #${issueNumber}: authoritative lease is missing, stale, or owned by another run`);
  }
  try {
    const branch = await git(workspace, ["branch", "--show-current"]);
    if (branch !== identity.branch) {
      return unsafe(`Cannot recover issue #${issueNumber}: canonical worktree is on ${branch || "no branch"}, expected ${identity.branch}`);
    }
    const conflicts = await git(workspace, ["diff", "--name-only", "--diff-filter=U"]);
    activity("checking repository state");
    if (conflicts.trim()) {
      activity("recovery unsafe · unresolved git conflicts");
      return unsafe(`Cannot recover issue #${issueNumber}: unresolved git conflicts (${conflicts.trim()})`);
    }
    activity("repository state is recoverable; preserving issue-local changes");
  } catch (error) {
    return unsafe(`Cannot inspect issue #${issueNumber} worktree before recovery: ${error instanceof Error ? error.message : String(error)}`);
  }

  activity("inspecting durable recovery evidence");
  const inferred = await inferCompletedArchive(workspace, state);
  if (inferred && inferred.issueNumber === issue) {
    activity("durable completion evidence found");
    const settled = await applyResult(workspace, state, inferred);
    const recovery = {
      ...baseRecovery,
      automaticSettlements: previous.automaticSettlements + 1,
      lastOutcome: "settled_from_durable_evidence" as const,
      lastReason: inferred.reason,
    };
    const recovered: LoopState = {
      ...settled.state,
      workerResultMissing: undefined,
      recovery,
      updatedAt: loopNow(),
      lastReason: `Automatically settled missing worker result: ${inferred.reason}`,
    };
    writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), recovered);
    recordLifecycleEvent(coordinationCwd, {
      event: "worker_recovery",
      issueNumber: issue,
      runId: state.runId,
      outcome: "recovered",
      reasonCode: "settled_from_durable_evidence",
    });
    await reportRuntimeFailure(coordinationCwd, {
      stage: "worker-recovery",
      category: "transient",
      severity: "info",
      outcome: "recovered",
      code: "worker_result_settled",
      summary: inferred.reason,
      issueNumber: issue,
      runId: state.runId,
    });
    return { outcome: "settled_from_durable_evidence", state: recovered, fingerprint };
  }

  const maxTotalAttempts = Math.max(
    maxAttempts,
    Math.trunc(options.maxTotalAttempts ?? maxAttempts * 3),
  );
  if (attempts >= maxAttempts || previous.missingLoopResults >= maxTotalAttempts) {
    return unsafe(`Automatic recovery exhausted after ${attempts} attempts for issue #${issue}; human inspection is required`, true);
  }

  activity("no durable completion evidence; preparing same-issue resume");
  const recovery = {
    ...baseRecovery,
    automaticResumes: previous.automaticResumes + 1,
    attemptsByFingerprint: { ...previous.attemptsByFingerprint, [fingerprint]: attempts + 1 },
    lastOutcome: "resuming_same_issue" as const,
    lastReason: `Resuming issue #${issueNumber} with a fresh worker; existing issue-worktree changes are preserved`,
  };
  const resumed: LoopState = {
    ...state,
    status: "running",
    settledStep: state.step,
    workerResultMissing: undefined,
    recovery,
    updatedAt: loopNow(),
    lastReason: recovery.lastReason,
    stopRequested: false,
  };
  writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), resumed);
  recordLifecycleEvent(coordinationCwd, {
    event: "worker_recovery",
    issueNumber: issue,
    runId: state.runId,
    outcome: "recovered",
    reasonCode: "resuming_same_issue",
  });
  await reportRuntimeFailure(coordinationCwd, {
    stage: "worker-recovery",
    category: "transient",
    severity: "info",
    outcome: "recovered",
    code: "worker_result_resumed",
    summary: recovery.lastReason,
    issueNumber: issue,
    runId: state.runId,
  });
  return { outcome: "resuming_same_issue", state: resumed, reason: recovery.lastReason, fingerprint };
}

async function recordPromptTelemetry(
  cwd: string,
  fallback: LoopState,
  telemetry: WorkerTelemetryReport,
  durationMs: number,
  hostSessionReplaced: boolean,
): Promise<LoopState> {
  const runtimeCwd = runtimeCwdFor(cwd, fallback);
  const current = readLoopState(runtimeCwd, fallback.runId) || fallback;
  // The worker report is this one turn's real aggregate usage, sourced from
  // the isolated child process's own event stream (#599) — never a
  // before/after delta against the parent's own session, which never runs
  // the model turn post-#591 and would always show zero.
  const delta = telemetry.usage ?? ZERO_USAGE;
  const available = telemetry.status !== "unavailable";
  const issueNumber = issueForTelemetry(cwd, runtimeCwd, fallback.runId);
  const next: LoopState = {
    ...current,
    metrics: addPromptMetrics(current.metrics, delta, durationMs, hostSessionReplaced, available),
    issueMetrics: addIssuePromptMetrics(
      current.issueMetrics,
      issueNumber,
      delta,
      durationMs,
      hostSessionReplaced,
      available,
    ),
    updatedAt: loopNow(),
  };
  writeJsonAtomic(loopStateFile(runtimeCwd, current.runId), next);
  return next;
}

function terminalControllerState(
  cwd: string,
  input: LoopState,
): LoopState | null {
  let state = input;
  if (state.status !== "running") return state;
  if (state.remainingIssues <= 0) {
    state = {
      ...state,
      status: "completed",
      updatedAt: loopNow(),
      lastReason: "Requested issue count completed",
    };
  } else if (state.stopRequested) {
    state = {
      ...state,
      status: "stopped",
      updatedAt: loopNow(),
      lastReason: "Stop requested at a clean step boundary",
    };
  } else if (state.step >= state.maxSteps) {
    state = {
      ...state,
      status: "blocked",
      updatedAt: loopNow(),
      lastReason: "Loop reached its bounded step limit",
    };
  } else {
    return null;
  }
  writeJsonAtomic(loopStateFile(runtimeCwdFor(cwd, state), state.runId), state);
  return state;
}

async function activePlanFreshness(cwd: string): Promise<{
  text: string;
  result: Awaited<ReturnType<typeof checkIssueFreshness>>;
}> {
  const issueNumber = currentPlanIssue(cwd);
  if (!issueNumber) {
    return {
      text: "PLAN.md does not expose a valid GitHub issue number. Treat the plan as untrusted and repair/stop before implementation.",
      result: {
        checked: false,
        needsReconcile: true,
        reason: "PLAN.md does not expose a valid GitHub issue number",
        eligibility: {
          disposition: "unavailable",
          eligible: false,
          reason: "active PLAN authority identity is ambiguous",
        },
      },
    };
  }
  const result = await checkIssueFreshness(cwd, issueNumber);
  const status = result.needsReconcile ? "RECONCILE REQUIRED" : "CURRENT";
  return {
    result,
    text: `${status} for #${issueNumber}: ${result.reason}${result.githubUpdatedAt ? ` github_updated=${result.githubUpdatedAt}` : ""}`,
  };
}

export async function runOneStep(
  ctx: ExtensionCommandContext,
  inputState: LoopState,
  workerBatchTransition: number,
  worker: IssueWorkerRunner,
  runtime: SupervisorRuntime,
): Promise<StepSettlement> {
  const config = loadPiNextConfig(ctx.cwd);
  let controllerInput = inputState;
  // Check an active PLAN before opening a worker/model step. Legacy metrics
  // receive a durable baseline here, so historical telemetry cannot exhaust a
  // policy that was introduced after it was collected.
  const preflightPlan = resolvePlanIdentity(ctx.cwd);
  if (preflightPlan.kind === "resolved" && inputState.activeIssueNumber) {
    const metric = inputState.issueMetrics.find((item) => item.issueNumber === inputState.activeIssueNumber);
    if (metric) {
      const initialized = initializeIssueBudgetBaseline(metric);
      if (initialized !== metric) {
        controllerInput = {
          ...inputState,
          issueMetrics: inputState.issueMetrics.map((item) => item.issueNumber === initialized.issueNumber ? initialized : item),
        };
      }
      const budget = issueBudgetDecision(initialized, config.convergence);
      if (budget.hard) {
        return applyResult(ctx.cwd, controllerInput, {
          runId: inputState.runId,
          step: inputState.step,
          schedulerOnly: true,
          issueNumber: inputState.activeIssueNumber,
          outcome: "yield_issue",
          reason: `issue convergence budget exhausted: ${budget.reason}; preserving PLAN/worktree for a later run`,
          writtenAt: loopNow(),
        });
      }
    }
  }
  const stepHead = await git(ctx.cwd, ["rev-parse", "HEAD"]);
  let state: LoopState = {
    ...controllerInput,
    status: "running",
    step: inputState.step + 1,
    workerBatchTransition,
    workerBatchTransitionLimit: MAX_WORKER_TRANSITIONS_PER_BATCH,
    // The deprecated fields are intentionally omitted from new serialized
    // state; their optional shape remains readable for v1 recovery.
    sessionTransition: undefined,
    sessionTransitionLimit: undefined,
    stepHead,
    stepStartedAt: loopNow(),
    updatedAt: loopNow(),
    lastOutcome: undefined,
    lastReason: undefined,
  };
  validateCanonicalExecutionState(ctx.cwd, state);
  validateWorkspacePlan(ctx.cwd, state.activeIssueNumber as number, {
    runId: state.runId,
    allowTaskMetadata: true,
  });
  const runtimeCwd = runtimeCwdFor(ctx.cwd, state);
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), state);
  removeFile(loopResultFile(runtimeCwd, state.runId));

  const plan = resolvePlanIdentity(ctx.cwd);
  if (plan.kind === "unresolved" || plan.kind === "ambiguous") {
    throw new PlanAuthorityError(plan.kind, plan.reason, plan.paths);
  }
  if (plan.kind === "resolved" && plan.provenance !== "canonical") {
    throw new PlanAuthorityError(
      "unowned",
      "Legacy issue-scoped PLAN artifacts require explicit authority reconciliation before resume",
      [plan.path],
    );
  }
  const hasPlan = plan.kind === "resolved";
  if (
    (!hasPlan &&
      state.activeIssueNumber &&
      (!state.activeLease || !state.activeWorkspace)) ||
    (hasPlan &&
      (state.activeIssueNumber !== plan.issueNumber ||
        !state.activeLease ||
        !state.activeWorkspace))
  ) {
    throw new PlanAuthorityError(
      "unowned",
      "Issue-plan execution requires an active lease and canonical workspace before model execution",
      plan.kind === "resolved" ? [plan.path] : [],
    );
  }
  const activeIssueNumber = state.activeIssueNumber;
  const pendingRepair = hasPlan && activeIssueNumber
    ? pendingPlanRepair(ctx.cwd, activeIssueNumber)
    : undefined;
  let planRepair = state.planRepair;
  if (pendingRepair) {
    const sameRepair = planRepair?.fingerprint === pendingRepair.fingerprint;
    const attempts = (sameRepair ? planRepair?.attempts || 0 : 0) + 1;
    const maxAttempts = sameRepair
      ? planRepair?.maxAttempts || DEFAULT_MAX_PLAN_REPAIR_ATTEMPTS
      : DEFAULT_MAX_PLAN_REPAIR_ATTEMPTS;
    if (attempts > maxAttempts) {
      const reason = `PLAN task metadata repair exhausted after ${maxAttempts} bounded attempts (${pendingRepair.errors.join("; ")})`;
      recordLifecycleEvent(runtimeCwdFor(ctx.cwd, state), {
        event: "issue_contained",
        issueNumber: activeIssueNumber as number,
        runId: state.runId,
        outcome: "failure",
        reasonCode: "plan_repair_exhausted",
        containment: {
          scope: "issue-local",
          stage: "workspace-validation",
          code: "plan_repair_exhausted",
          paths: [pendingRepair.path],
          leaseReleased: false,
        },
      });
      throw new IssueBoundaryFailure(
        activeIssueNumber as number,
        "workspace-validation",
        reason,
        [pendingRepair.path],
      );
    }
    planRepair = {
      attempts,
      maxAttempts,
      fingerprint: pendingRepair.fingerprint,
      lastErrors: pendingRepair.errors,
      updatedAt: loopNow(),
    };
    state = { ...state, planRepair, updatedAt: loopNow() };
    writeJsonAtomic(loopStateFile(runtimeCwdFor(ctx.cwd, state), state.runId), state);
  } else if (planRepair) {
    state = { ...state, planRepair: undefined, updatedAt: loopNow() };
    writeJsonAtomic(loopStateFile(runtimeCwdFor(ctx.cwd, state), state.runId), state);
  }
  const planFreshnessResult = hasPlan
    ? await activePlanFreshness(ctx.cwd)
    : undefined;
  const planFreshness = planFreshnessResult?.text;
  if (hasPlan && planFreshnessResult && !planFreshnessResult.result.eligibility.eligible) {
    const issueNumber = state.activeIssueNumber || currentPlanIssue(ctx.cwd);
    if (!issueNumber) throw new Error("Cannot yield an active plan without an issue identity");
    return applyResult(ctx.cwd, state, {
      runId: state.runId,
      step: state.step,
      issueNumber,
      outcome: "yield_issue",
      reason: `authority now ${planFreshnessResult.result.eligibility.disposition}: ${planFreshnessResult.result.eligibility.reason}`,
      writtenAt: loopNow(),
    });
  }
  const shortlist =
    hasPlan || state.activeIssueNumber
      ? { exhausted: false, text: undefined }
      : await candidateShortlist(ctx.cwd, {
          completedIssues: state.completedIssues,
          deferredIssues: state.deferredIssues.map((item) => item.issueNumber),
          leaseAuthority: new GitHubIssueLeaseAuthority(ctx.cwd),
        });
  const issueNumber = state.activeIssueNumber;
  if (hasPlan && issueNumber) {
    const metric = state.issueMetrics.find((item) => item.issueNumber === issueNumber);
    const budget = issueBudgetDecision(metric, config.convergence);
    if (budget.hard) {
      return applyResult(ctx.cwd, state, {
        runId: state.runId,
        step: state.step,
        issueNumber,
        outcome: "yield_issue",
        reason: `issue convergence budget exhausted: ${budget.reason}; preserving PLAN/worktree for a later run`,
        writtenAt: loopNow(),
      });
    }
    const tasks = planTaskCounts(ctx.cwd);
    const task = currentTask(readFileSync(planFile(ctx.cwd), "utf8"));
    const taskFingerprint = task
      ? feedbackFingerprint({ harness: "pi-next", stage: "controller", category: "runtime", code: "issue_task", summary: task.task })
      : undefined;
    const checkpoint = budget.soft || tasks.total > config.convergence.maxPlanTasksWarning;
    state = {
      ...state,
      issueMetrics: markIssueTransition(state.issueMetrics, issueNumber, tasks, taskFingerprint).map((item) =>
        item.issueNumber === issueNumber && checkpoint ? { ...item, softBudgetWarned: true } : item,
      ),
      lastReason: checkpoint
        ? `Issue #${issueNumber} convergence checkpoint: ${budget.reason || `${tasks.total} PLAN tasks`}; ${tasks.remaining}/${tasks.total} tasks remain`
        : undefined,
      updatedAt: loopNow(),
    };
    writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), state);
  }
  const started = Date.now();
  // Capture issue-local dirt before a planning repair. The repair worker may
  // preserve it, but it must not add or rewrite product paths while PLAN.md is
  // invalid. This snapshot is in-memory only and never becomes telemetry.
  const planRepairDirtyBefore = pendingRepair
    ? await snapshotPlanRepairDirtyState(ctx.cwd)
    : undefined;
  let allowDirtyPlanRepair = false;
  let planRepairBoundaryError: Error | undefined;
  let promptError: unknown;
  let telemetry: WorkerTelemetryReport = { status: "unavailable" };
  let phase: "planning" | "implementation";
  try {
    // An owned but semantically incomplete PLAN is never handed to an
    // implementation worker. The planning role is deliberately reused for a
    // bounded metadata-only repair turn.
    phase = pendingRepair ? "planning" : hasPlan ? "implementation" : "planning";
    // A child Pi process does not inherit the parent's selected model. Use the
    // explicit role policy when configured, otherwise carry the active parent
    // model across so `pi --model provider/model` also works for workers.
    const inheritedModel = ctx.model?.provider && ctx.model.id
      ? {
          model: `${ctx.model.provider}/${ctx.model.id}`,
          ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
        }
      : undefined;
    const configuredModel = config.workerDispatch.models[phase];
    const modelPolicy = inheritedModel || configuredModel
      ? { ...inheritedModel, ...configuredModel }
      : undefined;
    const dispatch = createWorkerDispatch({
      phase,
      hasPlan: hasPlan && !pendingRepair,
      issueNumber: state.activeIssueNumber,
      modelPolicy,
    });
    const task = worker(
      ctx.cwd,
      buildLoopPrompt({
        cwd: ctx.cwd,
        mode: hasPlan ? "resume" : "auto",
        dispatch,
        runId: state.runId,
        step: state.step,
        maxSteps: state.maxSteps,
        remainingIssues: state.remainingIssues,
        hasPlan,
        candidateShortlist: shortlist.text,
        candidateSearchExhausted: shortlist.exhausted,
        planFreshness,
        planRepair: pendingRepair && planRepair
          ? {
              issueNumber: state.activeIssueNumber as number,
              errors: pendingRepair.errors,
              attempt: planRepair.attempts,
              maxAttempts: planRepair.maxAttempts,
            }
          : undefined,
        recoveryReason:
          state.recovery?.lastOutcome === "resuming_same_issue"
            ? state.recovery.lastReason
            : undefined,
      }),
      {
        signal: runtime.currentGeneration()?.signal,
        issueNumber: state.activeIssueNumber,
        runId: state.runId,
        phase,
        dispatch,
        onWatchdog: (event: WorkerWatchdogEvent) => {
          try {
            recordLifecycleEvent(runtimeCwdFor(ctx.cwd, state), {
              event: "worker_stalled",
              issueNumber: state.activeIssueNumber || 0,
              runId: state.runId,
              outcome: event.kind === "worker_timeout" ? "failure" : "skip",
              reasonCode: event.kind,
            });
            safeNotify(ctx, `Issue #${state.activeIssueNumber || "?"} worker ${event.kind.replaceAll("_", " ")} · idle ${Math.round(event.idleMs / 1_000)}s`, event.kind === "worker_timeout" ? "warning" : "info");
          } catch {
            // Watchdog diagnostics and presentation cannot affect termination.
          }
        },
      },
    );
    const result = await task;
    if (planRepairDirtyBefore) {
      const dirtyState = await validatePlanRepairDirtyState(ctx.cwd, planRepairDirtyBefore);
      if (!dirtyState.safe) {
        planRepairBoundaryError = new IssueBoundaryFailure(
          state.activeIssueNumber || 0,
          "execution",
          dirtyState.reason || "planning repair changed product paths",
        );
      } else {
        // A still-invalid PLAN may remain dirty while the bounded repair is
        // retried. Once it validates, only pre-existing product dirt may cross
        // this planning boundary; an uncommitted valid PLAN must not proceed.
        const stillPending = state.activeIssueNumber
          ? Boolean(pendingPlanRepair(ctx.cwd, state.activeIssueNumber))
          : false;
        allowDirtyPlanRepair = !dirtyState.workflowDirty || stillPending;
      }
    }
    telemetry = result.telemetry;
    await reportWorkerToolFailures(ctx.cwd, telemetry.toolFailures, telemetry.recoveredToolFailureFingerprints);
    if (!result.ok) {
      const evidence = result.failure ?? createWorkerFailureEvidence(
        { output: result.output, code: result.code, signal: result.signal },
        {
          issueNumber: state.activeIssueNumber,
          runId: state.runId,
          phase,
          dispatch,
        },
      );
      const feedback = await reportRuntimeFailure(ctx.cwd, {
        stage: phase,
        category: evidence.category,
        severity: evidence.severity,
        outcome: "failed",
        code: evidence.code,
        summary: evidence.summary,
        error: evidence.diagnosticExcerpt,
        issueNumber: evidence.issueNumber,
        runId: evidence.runId,
        diagnosticRefs: evidence.diagnosticRefs,
        diagnostic: {
          phase: evidence.phase,
          role: evidence.role,
          model: evidence.modelPolicy?.model,
          exitCode: evidence.exitCode,
          signal: evidence.signal,
        },
      });
      throw new WorkerFailureError(evidence, feedback);
    }
  } catch (error) {
    promptError = error;
  }
  if (planRepairBoundaryError) {
    removeFile(loopResultFile(runtimeCwdFor(ctx.cwd, state), state.runId));
    promptError = planRepairBoundaryError;
  }
  state = await recordPromptTelemetry(
    ctx.cwd,
    state,
    telemetry,
    Date.now() - started,
    false,
  );
  const observedHead = await git(ctx.cwd, ["rev-parse", "HEAD"]);
  const completedIssue = state.activeIssueNumber;
  if (completedIssue) {
    state = {
      ...state,
      issueMetrics: recordIssueTransitionResult(
        state.issueMetrics,
        completedIssue,
        Date.now() - started,
        Boolean(state.stepHead && observedHead !== state.stepHead),
        hasPlan && planNeedsFinalLifecycle(ctx.cwd),
      ),
      updatedAt: loopNow(),
    };
    writeJsonAtomic(loopStateFile(runtimeCwdFor(ctx.cwd, state), state.runId), state);
  }
  // Health is evaluated online, before issue-boundary maintenance. It only
  // records deterministic evidence and may create a held finding; it cannot
  // grant authority, weaken verification, or turn a failed transition into a
  // success.
  let reportedTransition = promptError ? "failed" : "transition";
  try {
    const resultPath = loopResultFile(runtimeCwdFor(ctx.cwd, state), state.runId);
    if (existsSync(resultPath)) {
      const reported = JSON.parse(readFileSync(resultPath, "utf8")) as LoopResult;
      reportedTransition = reported.outcome;
    }
  } catch {
    // The health controller remains useful even when result recovery is not.
  }
  try {
    await observeManagedTransition(runtimeCwdFor(ctx.cwd, state), {
      runId: state.runId,
      issueNumber: state.activeIssueNumber,
      transitionType: reportedTransition,
      durableProgress: Boolean(state.stepHead && observedHead !== state.stepHead),
      failureFingerprint: promptError
        ? feedbackFingerprint({
            harness: "pi-next",
            stage: "worker-transition",
            category: "runtime",
            code: "worker_transition_failed",
            summary: promptError instanceof Error ? promptError.message : String(promptError),
          })
        : undefined,
      failureFingerprints: telemetry.toolFailures?.map((failure) => failure.fingerprint),
      expectedFailureFingerprints: telemetry.toolFailures
        ?.filter((failure) => failure.failureClass === "expected_current_work")
        .map((failure) => failure.fingerprint),
      recoveredFailureFingerprints: telemetry.recoveredToolFailureFingerprints,
      promptCount: telemetry.activity?.modelRounds,
      freshTokens: telemetry.usage ? telemetry.usage.input + telemetry.usage.output : 0,
      lifecycleEvents: [
        ...recentLifecycleEventNames(runtimeCwdFor(ctx.cwd, state)),
        ...recentLifecycleEventNames(ctx.cwd),
      ],
      at: loopNow(),
    }, loadPiNextConfig(ctx.cwd));
  } catch {
    // Health is diagnostic; persistence or publication failures cannot alter
    // the worker transition's authoritative result.
  }
  if (promptError) {
    const resultPath = loopResultFile(runtimeCwdFor(ctx.cwd, state), state.runId);
    if (existsSync(resultPath)) {
      // A worker may have written the authoritative terminal result and then
      // failed while its process was unwinding. The result wins over the
      // process exit classification.
      const settled = await settleStep(ctx.cwd, state, { allowDirtyPlanRepair });
      if (!hasPlan && existsSync(planFile(ctx.cwd))) {
        const plannedIssue = currentPlanIssue(ctx.cwd);
        if (plannedIssue) await primeIssueFreshness(ctx.cwd, plannedIssue);
      }
      return settled;
    }
    const missing: LoopState = {
      ...state,
      workerResultMissing: true,
      updatedAt: loopNow(),
      lastReason: `Worker exited without pi_next_update(action=loop_result): ${promptError instanceof Error ? promptError.message : String(promptError)}`,
    };
    writeJsonAtomic(loopStateFile(runtimeCwdFor(ctx.cwd, state), state.runId), missing);
    throw promptError;
  }

  const settled = await settleStep(ctx.cwd, state, { allowDirtyPlanRepair });
  if (!hasPlan && existsSync(planFile(ctx.cwd))) {
    const plannedIssue = currentPlanIssue(ctx.cwd);
    if (plannedIssue) await primeIssueFreshness(ctx.cwd, plannedIssue);
  }
  return settled;
}

async function runWorkerBatch(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  worker: IssueWorkerRunner,
  runtime: SupervisorRuntime,
): Promise<void> {
  let state = initial;
  for (
    let transition = 1;
    transition <= MAX_WORKER_TRANSITIONS_PER_BATCH;
    transition += 1
  ) {
    state = readLoopState(runtimeCwdFor(ctx.cwd, state), state.runId) || state;
    const terminal = terminalControllerState(ctx.cwd, state);
    if (terminal) return;
    if (
      transition > 1 &&
      (!existsSync(planFile(ctx.cwd)) || planNeedsFinalLifecycle(ctx.cwd))
    ) {
      return;
    }

    state = observeLoopHostMemory(ctx.cwd, state, {
      boundary: "worker_start",
      workerBatchTransition: transition,
    });
    if (state.status !== "running") return;
    const settled = await runOneStep(ctx, state, transition, worker, runtime);
    state = settled.state;
    state = observeLoopHostMemory(ctx.cwd, state, {
      boundary: "worker_end",
      workerBatchTransition: transition,
    });
    if (state.status !== "running") return;
    if (settled.terminal) return;
    if (
      settled.outcome === "done" ||
      settled.outcome === "archived" ||
      settled.outcome === "defer_issue" ||
      settled.outcome === "block_issue" ||
      settled.outcome === "yield_issue" ||
      !existsSync(planFile(ctx.cwd)) ||
      planNeedsFinalLifecycle(ctx.cwd)
    ) {
      return;
    }
  }
}

function interruptLoop(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  error: unknown,
): void {
  const runtimeCwd = runtimeCwdFor(ctx.cwd, initial);
  const current = readLoopState(runtimeCwd, initial.runId) || initial;
  const interrupted: LoopState = {
    ...current,
    status: "interrupted",
    updatedAt: loopNow(),
    lastReason: error instanceof Error ? error.message : String(error),
  };
  writeJsonAtomic(loopStateFile(runtimeCwdFor(ctx.cwd, current), current.runId), interrupted);
  notifyLoopState(ctx, interrupted);
}

async function driveLoop(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  worker: IssueWorkerRunner,
  runtime: SupervisorRuntime,
  display?: WorkerDisplayController,
): Promise<void> {
  let state = initial;
  const executeWorker: IssueWorkerRunner = (cwd, prompt, options = {}) => {
    const generation = runtime.currentGeneration();
    const task = worker(cwd, prompt, {
      ...options,
      signal: options.signal ?? generation?.signal,
    });
    return generation
      ? generation.track(task, { kind: "subprocess" })
      : task;
  };
  while (true) {
    state = readLoopState(runtimeCwdFor(ctx.cwd, state), state.runId) || state;
    const pending = await settleStep(ctx.cwd, state);
    state = pending.state;
    if (pending.terminal) {
      notifyLoopState(ctx, state);
      return;
    }
    // A completed or deferred issue must return to the coordination boundary
    // before another candidate is claimed. The outer owner restores the root
    // cwd, releases this issue lease, and attaches the next issue workspace.
    if (
      pending.outcome &&
      ["archived", "defer_issue", "block_issue", "yield_issue"].includes(pending.outcome)
    ) {
      return;
    }
    const terminal = terminalControllerState(ctx.cwd, state);
    if (terminal) {
      notifyLoopState(ctx, terminal);
      return;
    }

    if (maintenanceOwed(ctx.cwd, state)) {
      const decision = await issueBoundaryMaintenanceDecision(ctx.cwd, state);
      if (!decision) continue;
      if (!decision.shouldTune) {
        await runIssueBoundaryMaintenance(ctx, state, decision, executeWorker);
        state = readLoopState(runtimeCwdFor(ctx.cwd, state), state.runId) || state;
        continue;
      }

      // Maintenance is another isolated child-worker turn, not a reason to
      // tear down the interactive host runtime. Begin a fresh controller
      // generation while retaining the same live ExtensionCommandContext.
      await runtime.beginGeneration(`driveLoop:maintenance:${state.runId}`, {
        cwd: ctx.cwd,
        runId: state.runId,
        issueNumber: state.activeIssueNumber,
      });
      state = observeLoopHostMemory(ctx.cwd, state, {
        boundary: "before_maintenance",
        workerBatchTransition: state.workerBatchTransition,
      });
      if (state.status !== "running") return;
      await runIssueBoundaryMaintenance(ctx, state, decision, executeWorker);
      state = readLoopState(runtimeCwdFor(ctx.cwd, state), state.runId) || state;
      continue;
    }

    // Child workers are the freshness boundary. Controller transitions remain
    // on the current host context so ordinary auto progression cannot invoke
    // the host-runtime replacement primitive (`ctx.newSession()`).
    await runtime.beginGeneration(`driveLoop:worker-batch:${state.runId}`, {
      cwd: ctx.cwd,
      runId: state.runId,
      issueNumber: state.activeIssueNumber,
    });
    state = observeLoopHostMemory(ctx.cwd, state, {
      boundary: "before_worker_batch",
      workerBatchTransition: state.workerBatchTransition,
    });
    if (state.status !== "running") return;
    await runWorkerBatch(ctx, state, executeWorker, runtime);
    state = readLoopState(runtimeCwdFor(ctx.cwd, state), state.runId) || state;
    // Continue in this same host session for the next bounded worker batch.
    continue;
  }
}

export async function runLoopSteps(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  worker: IssueWorkerRunner = runIssueWorker,
  runtime: SupervisorRuntime = createSupervisorRuntime(),
  observer?: WorkerObserver,
): Promise<void> {
  validateCanonicalExecutionState(ctx.cwd, initial);
  // Task Files/Approach defects are owned workflow quality failures. Keep the
  // outer production-path preflight consistent with runOneStep so the bounded
  // planning-only repair worker is reachable; every other PLAN defect remains
  // fail-closed here.
  validateWorkspacePlan(ctx.cwd, initial.activeIssueNumber as number, {
    runId: initial.runId,
    allowTaskMetadata: true,
  });
  initial = observeLoopHostMemory(ctx.cwd, initial, {
    boundary: "supervisor_start",
  });
  if (initial.status !== "running") return;
  // Callers may supply the owner-bound sink from their command context;
  // direct callers get a sink attached to this stable host context. It is
  // threaded through isolated child-worker turns, never host replacements.
  const ownsDisplay = !observer?.display;
  const display = observer?.display ?? attachWorkerDisplay(ctx);
  const release = acquireControllerLock(
    runtimeCwdFor(ctx.cwd, initial),
    initial.runId,
  );
  const generation = await runtime.beginGeneration(`runLoopSteps:${initial.runId}`, {
    cwd: ctx.cwd,
    runId: initial.runId,
    issueNumber: initial.activeIssueNumber,
  });
  const observedWorker: IssueWorkerRunner = (cwd, prompt, options = {}) =>
    worker(cwd, prompt, {
      ...options,
      issueNumber: options.issueNumber ?? initial.activeIssueNumber,
      runId: options.runId ?? initial.runId,
      onActivity: options.onActivity ?? observer?.onActivity,
      onWorkerState: options.onWorkerState ?? observer?.onWorkerState,
      display: options.display ?? display,
    });
  let finalMemoryBoundary = "supervisor_settle";
  try {
    await driveLoop(ctx, initial, observedWorker, runtime, display);
  } catch (error) {
    finalMemoryBoundary = "supervisor_abort";
    const classification = classifyFailure(error, {
      stage: "execution",
      issueNumber: initial.activeIssueNumber,
      workspace: ctx.cwd,
      coordinationCwd: runtimeCwdFor(ctx.cwd, initial),
      ownershipProven: true,
    });
    if (classification.scope === "issue-local") throw error;
    interruptLoop(ctx, initial, error);
  } finally {
    const finalState = readLoopState(runtimeCwdFor(ctx.cwd, initial), initial.runId) || initial;
    observeLoopHostMemory(ctx.cwd, finalState, { boundary: finalMemoryBoundary });
    // Each controller batch replaces the previous child-worker generation via
    // beginGeneration(), which records bounded teardown diagnostics. The
    // initial generation is therefore normally already disposed here; the
    // fallback teardown covers a run that ended before its first batch.
    if (!generation.isDisposed()) {
      await runtime.teardown(
        generation,
        `runLoopSteps:complete:${initial.runId}`,
        {
          cwd: ctx.cwd,
          runId: initial.runId,
          issueNumber: initial.activeIssueNumber,
        },
      );
    } else {
      await generation.teardown(`runLoopSteps:complete:${initial.runId}`);
    }
    if (ownsDisplay) display?.dispose();
    release();
  }
}

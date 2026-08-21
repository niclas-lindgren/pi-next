import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
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
import { currentTask } from "./plan.ts";
import { setLiveCtx } from "./live-ctx.ts";
import { buildLoopPrompt } from "./prompt.ts";
import {
  PlanAuthorityError,
  resolvePlanIdentity,
  runIssueWorker,
  type IssueWorkerOptions,
  type IssueWorkerRunner,
} from "./util-core.ts";
import { git, planFile, removeFile, workflowPath, writeJsonAtomic } from "./util.ts";
import {
  acquireControllerLock,
  addIssuePromptMetrics,
  addPromptMetrics,
  loopNow,
  loopResultFile,
  loopStateFile,
  markIssueDisposition,
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
import { reportRuntimeFailure } from "./feedback-runtime.ts";
import {
  createWorkerFailureEvidence,
  WorkerFailureError,
} from "./worker-failure.ts";
import { classifyFailure, IssueBoundaryFailure } from "./failure-scope.ts";

const MAX_TRANSITIONS_PER_SESSION = 3;
/** Maximum fresh workers for one normalized missing-result failure. */
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

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
): Promise<StepSettlement> {
  const runtimeCwd = runtimeCwdFor(cwd, state);
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
    if (!boundary.safe) {
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
    if (!state.stepHead || head === state.stepHead) {
      return blockForNoProgress(cwd, state, result);
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
): Promise<StepSettlement> {
  if (state.step <= state.settledStep) {
    return { state, terminal: state.status !== "running" };
  }
  const runtimeCwd = runtimeCwdFor(cwd, state);
  if (existsSync(loopResultFile(runtimeCwd, state.runId))) {
    const result = JSON.parse(
      readFileSync(loopResultFile(runtimeCwd, state.runId), "utf8"),
    ) as LoopResult;
    return applyResult(cwd, state, result);
  }
  const inferred = await inferCompletedArchive(cwd, state);
  if (inferred) return applyResult(cwd, state, inferred);

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
  newSession: boolean,
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
    metrics: addPromptMetrics(current.metrics, delta, durationMs, newSession, available),
    issueMetrics: addIssuePromptMetrics(
      current.issueMetrics,
      issueNumber,
      delta,
      durationMs,
      newSession,
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

async function activePlanFreshness(cwd: string): Promise<string | undefined> {
  const issueNumber = currentPlanIssue(cwd);
  if (!issueNumber) {
    return "PLAN.md does not expose a valid GitHub issue number. Treat the plan as untrusted and repair/stop before implementation.";
  }
  const freshness = await checkIssueFreshness(cwd, issueNumber);
  const status = freshness.needsReconcile ? "RECONCILE REQUIRED" : "CURRENT";
  return `${status} for #${issueNumber}: ${freshness.reason}${freshness.githubUpdatedAt ? ` github_updated=${freshness.githubUpdatedAt}` : ""}`;
}

async function runOneStep(
  ctx: ExtensionCommandContext,
  inputState: LoopState,
  transitionInSession: number,
  worker: IssueWorkerRunner,
  runtime: SupervisorRuntime,
): Promise<StepSettlement> {
  const stepHead = await git(ctx.cwd, ["rev-parse", "HEAD"]);
  let state: LoopState = {
    ...inputState,
    status: "running",
    step: inputState.step + 1,
    sessionTransition: transitionInSession,
    sessionTransitionLimit: MAX_TRANSITIONS_PER_SESSION,
    stepHead,
    stepStartedAt: loopNow(),
    updatedAt: loopNow(),
    lastOutcome: undefined,
    lastReason: undefined,
  };
  validateCanonicalExecutionState(ctx.cwd, state);
  validateWorkspacePlan(ctx.cwd, state.activeIssueNumber as number, { runId: state.runId });
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
  const planFreshness = hasPlan
    ? await activePlanFreshness(ctx.cwd)
    : undefined;
  const shortlist =
    hasPlan || state.activeIssueNumber
      ? { exhausted: false, text: undefined }
      : await candidateShortlist(ctx.cwd, {
          completedIssues: state.completedIssues,
          deferredIssues: state.deferredIssues.map((item) => item.issueNumber),
          leaseAuthority: new GitHubIssueLeaseAuthority(ctx.cwd),
        });
  const started = Date.now();
  let promptError: unknown;
  let telemetry: WorkerTelemetryReport = { status: "unavailable" };
  try {
    const phase = hasPlan ? "implementation" : "planning" as const;
    const config = loadPiNextConfig(ctx.cwd);
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
      hasPlan,
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
      },
    );
    const result = await task;
    telemetry = result.telemetry;
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
  state = await recordPromptTelemetry(
    ctx.cwd,
    state,
    telemetry,
    Date.now() - started,
    transitionInSession === 1,
  );
  // Health is evaluated online, before issue-boundary maintenance. It only
  // records deterministic evidence and may create a held finding; it cannot
  // grant authority, weaken verification, or turn a failed transition into a
  // success.
  const observedHead = await git(ctx.cwd, ["rev-parse", "HEAD"]);
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
      const settled = await settleStep(ctx.cwd, state);
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

  const settled = await settleStep(ctx.cwd, state);
  if (!hasPlan && existsSync(planFile(ctx.cwd))) {
    const plannedIssue = currentPlanIssue(ctx.cwd);
    if (plannedIssue) await primeIssueFreshness(ctx.cwd, plannedIssue);
  }
  return settled;
}

async function runSessionBatch(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  worker: IssueWorkerRunner,
  runtime: SupervisorRuntime,
): Promise<void> {
  let state = initial;
  for (
    let transition = 1;
    transition <= MAX_TRANSITIONS_PER_SESSION;
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

    const settled = await runOneStep(ctx, state, transition, worker, runtime);
    state = settled.state;
    if (settled.terminal) return;
    if (
      settled.outcome === "done" ||
      settled.outcome === "archived" ||
      settled.outcome === "defer_issue" ||
      settled.outcome === "block_issue" ||
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
      ["archived", "defer_issue", "block_issue"].includes(pending.outcome)
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

      await runtime.beginGeneration(`driveLoop:maintenance:${state.runId}`, {
        cwd: ctx.cwd,
        runId: state.runId,
        issueNumber: state.activeIssueNumber,
      });
      const workerCwd = ctx.cwd;
      await ctx.newSession({
        withSession: async (next: ExtensionCommandContext) => {
          const workerContext = { ...next, cwd: workerCwd } as ExtensionCommandContext;
          setLiveCtx(workerContext);
          // Every ctx.newSession() transition replaces the live ctx (#616);
          // re-register it so long-lived callbacks (worker progress/activity,
          // lease notifications, the live display widget) keep resolving the
          // actually-live session instead of throwing on the torn-down one.
          attachWorkerDisplay(workerContext, display);
          try {
            await runIssueBoundaryMaintenance(workerContext, state, decision, executeWorker);
            const latest = readLoopState(runtimeCwdFor(workerCwd, state), state.runId) || state;
            await driveLoop(workerContext, latest, executeWorker, runtime, display);
          } catch (error) {
            const classification = classifyFailure(error, {
              stage: "execution",
              issueNumber: state.activeIssueNumber,
              workspace: workerCwd,
              coordinationCwd: runtimeCwdFor(workerCwd, state),
              ownershipProven: true,
            });
            if (classification.scope === "issue-local") throw error;
            interruptLoop(workerContext, state, error);
          }
        },
      });
      return;
    }

    await runtime.beginGeneration(`driveLoop:transition:${state.runId}`, {
      cwd: ctx.cwd,
      runId: state.runId,
      issueNumber: state.activeIssueNumber,
    });
    const workerCwd = ctx.cwd;
    await ctx.newSession({
      withSession: async (next: ExtensionCommandContext) => {
        const workerContext = { ...next, cwd: workerCwd } as ExtensionCommandContext;
        setLiveCtx(workerContext);
        // See the identical note in the maintenance branch above (#616).
        attachWorkerDisplay(workerContext, display);
        try {
          await runSessionBatch(workerContext, state, executeWorker, runtime);
          const latest = readLoopState(runtimeCwdFor(workerCwd, state), state.runId) || state;
          await driveLoop(workerContext, latest, executeWorker, runtime, display);
        } catch (error) {
          const classification = classifyFailure(error, {
            stage: "execution",
            issueNumber: state.activeIssueNumber,
            workspace: workerCwd,
            coordinationCwd: runtimeCwdFor(workerCwd, state),
            ownershipProven: true,
          });
          if (classification.scope === "issue-local") throw error;
          interruptLoop(workerContext, state, error);
        }
      },
    });
    return;
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
  validateWorkspacePlan(ctx.cwd, initial.activeIssueNumber as number, { runId: initial.runId });
  // Callers may supply the owner-bound sink from their command context;
  // direct callers get a sink attached to this context. It is threaded through
  // every newSession() boundary instead of being routed through a singleton.
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
  try {
    await driveLoop(ctx, initial, observedWorker, runtime, display);
  } catch (error) {
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
    // A driveLoop() chain that handed off to ctx.newSession() has already
    // replaced this generation via beginGeneration() — which already
    // recorded its teardown diagnostics — so teardown() below is a no-op in
    // that case (idempotent, no duplicate telemetry) and a real bounded,
    // recorded teardown when this run ended without a replacement.
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
    display?.dispose();
    release();
  }
}

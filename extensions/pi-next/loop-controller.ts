import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  validateCanonicalExecutionState,
  validateWorkspacePlan,
} from "./execution-boundary.ts";
import { checkIssueFreshness, primeIssueFreshness } from "./issue-freshness.ts";
import { candidateShortlist } from "./issue-candidates.ts";
import { attachWorkerDisplay, type WorkerDisplayController } from "./worker-display.ts";
import { GitHubIssueLeaseAuthority } from "./issue-leases.ts";
import {
  createSupervisorRuntime,
  type SupervisorRuntime,
} from "./supervisor-runtime.ts";
import {
  maintenanceDecision,
  maintenanceOwed,
  runIssueBoundaryMaintenance,
} from "./loop-maintenance.ts";
import { currentTask } from "./plan.ts";
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
  safeLoopNotify,
  safeLoopBoundary,
  ZERO_USAGE,
  type LoopOutcome,
  type LoopResult,
  type LoopState,
  type LoopStatus,
} from "./loop-state.ts";
import type { WorkerTelemetryReport } from "./worker-telemetry.ts";

const MAX_TRANSITIONS_PER_SESSION = 3;

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
): Promise<StepSettlement> {
  const blocked: LoopState = {
    ...state,
    status: "blocked",
    settledStep: state.step,
    updatedAt: loopNow(),
    lastOutcome: result.outcome,
    lastReason: `Step reported ${result.outcome} without advancing HEAD; refusing a no-op unattended retry`,
  };
  const runtimeCwd = runtimeCwdFor(cwd, state);
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), blocked);
  removeFile(loopResultFile(runtimeCwd, state.runId));
  return { state: blocked, terminal: true, outcome: result.outcome };
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
      const failed: LoopState = {
        ...state,
        status: "failed",
        settledStep: state.step,
        updatedAt: loopNow(),
        lastOutcome: result.outcome,
        lastReason: boundary.reason,
      };
      writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), failed);
      removeFile(loopResultFile(runtimeCwd, state.runId));
      return { state: failed, terminal: true, outcome: "failed" };
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

async function inferCompletedArchive(
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
    updatedAt: loopNow(),
    lastReason:
      "Session ended without pi_next_update(action=loop_result); use resume after checking the worktree",
  };
  writeJsonAtomic(loopStateFile(runtimeCwd, state.runId), interrupted);
  return { state: interrupted, terminal: true, outcome: "failed" };
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
    stepHead,
    stepStartedAt: loopNow(),
    updatedAt: loopNow(),
    lastOutcome: undefined,
    lastReason: undefined,
  };
  validateCanonicalExecutionState(ctx.cwd, state);
  validateWorkspacePlan(ctx.cwd, state.activeIssueNumber as number);
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
      ? { exhausted: false }
      : await candidateShortlist(ctx.cwd, {
          completedIssues: state.completedIssues,
          deferredIssues: state.deferredIssues.map((item) => item.issueNumber),
          leaseAuthority: new GitHubIssueLeaseAuthority(ctx.cwd),
        });
  safeLoopNotify(
    ctx,
    `pi-next step ${state.step}/${state.maxSteps}; issues remaining ${state.remainingIssues}; session transition ${transitionInSession}/${MAX_TRANSITIONS_PER_SESSION}`,
    "info",
  );

  const started = Date.now();
  let promptError: unknown;
  let telemetry: WorkerTelemetryReport = { status: "unavailable" };
  try {
    const task = worker(
      ctx.cwd,
      buildLoopPrompt({
        cwd: ctx.cwd,
        mode: hasPlan ? "resume" : "auto",
        runId: state.runId,
        step: state.step,
        maxSteps: state.maxSteps,
        remainingIssues: state.remainingIssues,
        hasPlan,
        candidateShortlist: shortlist.text,
        candidateSearchExhausted: shortlist.exhausted,
        planFreshness,
      }),
      {
        signal: runtime.currentGeneration()?.signal,
        issueNumber: state.activeIssueNumber,
        runId: state.runId,
        phase: hasPlan ? "implementation" : "planning",
      },
    );
    const result = await task;
    telemetry = result.telemetry;
    if (!result.ok) {
      throw new Error(
        `Issue worker failed (${result.signal || `exit ${result.code ?? "unknown"}`})`,
      );
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
  if (promptError) throw promptError;

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
      const decision = maintenanceDecision(state);
      if (!decision) continue;
      safeLoopNotify(
        ctx,
        `Pi loop issue-boundary maintenance after #${state.completedIssues[state.completedIssues.length - 1]}`,
        "info",
      );
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
        // See the identical note in the maintenance branch above (#616).
        attachWorkerDisplay(workerContext, display);
        try {
          await runSessionBatch(workerContext, state, executeWorker, runtime);
          const latest = readLoopState(runtimeCwdFor(workerCwd, state), state.runId) || state;
          await driveLoop(workerContext, latest, executeWorker, runtime, display);
        } catch (error) {
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
  validateWorkspacePlan(ctx.cwd, initial.activeIssueNumber as number);
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

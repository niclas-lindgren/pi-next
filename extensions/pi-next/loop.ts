import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { relative } from "node:path";

import { trackCrashLoggerCwd } from "./crash-log.ts";
import {
  reconcileWorkspacePlan,
  validateCanonicalExecutionState,
  validateWorkspacePlan,
} from "./execution-boundary.ts";
import { commitExplicitPaths } from "./commit-safety.ts";
import { cleanupCompletedIssueWorktree } from "./main-refresh.ts";
import {
  reconcileMissingLoopResult,
  runLoopSteps,
} from "./loop-controller.ts";
import {
  CandidateDiscoveryError,
  candidateShortlist,
} from "./issue-candidates.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { reportRuntimeFailure } from "./feedback-runtime.ts";
import {
  classifyFailure,
  IssueHandoffError,
  type FailureClassification,
} from "./failure-scope.ts";
import {
  claimIssueLease,
  ensureIssueWorktree,
  GitHubIssueLeaseAuthority,
  ISSUE_LEASE_DURATION_MS,
  releaseIssueLease,
  reconcileIssueLeaseForResume,
  parseLeaseFromAuthority,
  startIssueLeaseHeartbeat,
} from "./issue-leases.ts";
import {
  emptyLoopMetrics,
  loopNow,
  listLoopStates,
  loopResultFile,
  loopStateFile,
  markIssueDisposition,
  MAX_STEPS,
  notifyLoopState,
  parseLoopLimit,
  readLoopState,
  safeLoopBoundary,
  type LoopState,
} from "./loop-state.ts";
import {
  PlanAuthorityError,
  safeNotify,
  verifyFile,
  writeJsonAtomic,
} from "./util.ts";
import {
  quarantineInheritedWorkflowArtifacts,
  quarantineLegacyCoordinationArtifacts,
  relativeWorkflowPaths,
} from "./plan-write.ts";
import { workflowArtifacts } from "./plan-read.ts";
import { runIssueWorker, type IssueWorkerRunner } from "./util-core.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";
import { appendWorkerNarrative, type WorkerWorkLogSink } from "./work-log.ts";
import { attachWorkerDisplay } from "./worker-display.ts";
import { getLiveCtx, sessionIdentity } from "./live-ctx.ts";
import {
  createSupervisorRuntime,
  type SupervisorRuntime,
} from "./supervisor-runtime.ts";
import { ForegroundSupervisor } from "./foreground-supervisor.ts";
import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { createWorkAuthority } from "../../src/coordination/work-authority.ts";
import { publishSelfAssessmentFindings, refreshFindingApprovals } from "./self-assessment.ts";

export { MAX_ISSUES, readLoopState, writeLoopResult } from "./loop-state.ts";
export { ForegroundSupervisor } from "./foreground-supervisor.ts";
export type { LoopOutcome, LoopResult, LoopState } from "./loop-state.ts";

const AUTO_STATUS_KEY = "pi-next-auto";

/**
 * Delivers through the shared lifecycle-aware host boundary (#583) instead
 * of duplicating the try/catch-rejection contract locally. Not gated on the
 * supervisor runtime: these notifications (claim/worktree failures,
 * lease-renewal errors) can fire outside a worker lifetime, so checking an
 * unrelated run's disposal state would be incorrect here.
 */
function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  safeNotify(ctx, message, level);
}

/**
 * For callbacks that can fire well after the ctx they closed over was
 * created — worker progress/activity timers, lease-heartbeat notifications
 * — a captured `ctx` is not safe to use directly (#616): `driveLoop`
 * replaces the live ctx via `ctx.newSession()` on essentially every step,
 * and the old one throws "stale" the next time `ctx.ui` is touched. These
 * callbacks resolve the actually-live ctx through the single registry in
 * `live-ctx.ts` instead, so they always target whichever session the host
 * has replaced it with. A missing live ctx (no command has attached one
 * yet, or the run has no UI) is a silent no-op, matching `safeNotify`'s
 * existing "diagnostic only" contract.
 */
function notifyLive(
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const ctx = getLiveCtx();
  if (!ctx) return;
  safeNotify(ctx, message, level);
}

function workerActivityText(event: WorkerWorkLogEvent): string {
  const issue = event.issueNumber ? `#${event.issueNumber}` : "#?";
  const run = event.runId ? ` · ${event.runId.slice(0, 12)}` : "";
  const paths = event.relatedPaths?.length ? ` · ${event.relatedPaths.join(", ")}` : "";
  return `pi-next ${issue}${run} · ${event.phase} · ${event.kind} · ${event.summary}${paths}`;
}

/**
 * Safely settle one attributed issue-local failure without touching its
 * checkout. The first write records the disposition while ownership evidence
 * is still present; only the second write clears active execution fields.
 */
export async function containIssueLocalFailure(
  coordinationCwd: string,
  state: LoopState,
  failure: FailureClassification,
  options: {
    lease?: import("./issue-authority.ts").IssueLease;
    leaseReleased?: boolean;
    authority?: import("./issue-leases.ts").IssueLeaseAuthority;
  } = {},
): Promise<LoopState> {
  const issueNumber = failure.issueNumber;
  if (!issueNumber || failure.scope !== "issue-local") {
    throw new Error("Issue containment requires an attributed issue-local failure");
  }

  // Containment is a durable, idempotent transition. A retry after the first
  // write must not consume another requested slot or notify the operator again.
  const alreadyContained = state.deferredIssues.find((item) => item.issueNumber === issueNumber);

  let leaseReleased = options.leaseReleased === true;
  const authority = options.authority ?? new GitHubIssueLeaseAuthority(coordinationCwd);
  const lease = options.lease ?? (state.activeLease
    ? parseLeaseFromAuthority(JSON.stringify(state.activeLease))
    : undefined);
  if (!leaseReleased && lease) {
    // releaseIssueLease performs a fresh authority read and owner comparison;
    // never remove a ref merely because local state says we owned it.
    try {
      await releaseIssueLease(authority, lease, {
        cwd: coordinationCwd,
        recordEvent: recordLifecycleEvent,
      });
      leaseReleased = true;
    } catch (error) {
      const reason = `Cannot safely release issue #${issueNumber} lease after issue-local failure: ${error instanceof Error ? error.message : String(error)}`;
      const interrupted = {
        ...state,
        status: "interrupted" as const,
        updatedAt: loopNow(),
        lastReason: reason,
      };
      writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), interrupted);
      throw new Error(reason);
    }
  }
  if (!leaseReleased && state.activeLease) {
    throw new Error(`Cannot safely release issue #${issueNumber} lease; preserving ownership evidence and stopping globally`);
  }

  if (alreadyContained && !state.activeLease && !state.activeIssueNumber && !state.activeWorkspace) {
    return state;
  }

  const newContainment = !alreadyContained;
  const paths = failure.paths.length ? ` Paths: ${failure.paths.join(", ")}.` : "";
  const reason = alreadyContained?.reason || `Issue #${issueNumber} blocked for this run: ${failure.reason}.${paths} Workspace preserved; lease ${leaseReleased ? "released" : "not held"}.`;
  const deferredAt = loopNow();
  const disposition: LoopState = {
    ...state,
    status: "running",
    workerResultMissing: undefined,
    remainingIssues: newContainment
      ? Math.max(0, state.remainingIssues - 1)
      : state.remainingIssues,
    deferredIssues: newContainment
      ? [
          ...state.deferredIssues.filter((item) => item.issueNumber !== issueNumber),
          { issueNumber, reason, deferredAt, kind: "blocked" },
        ]
      : state.deferredIssues,
    issueMetrics: markIssueDisposition(state.issueMetrics, issueNumber, "blocked", reason),
    lastOutcome: "block_issue",
    lastReason: reason,
    updatedAt: deferredAt,
  };
  // Durable containment precedes clearing the active identity. A crash after
  // this write leaves an auditable blocked disposition rather than a silent
  // retry; the normal next write removes only controller pointers.
  writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), disposition);
  const cleared: LoopState = {
    ...disposition,
    activeIssueNumber: undefined,
    activeWorkspace: undefined,
    activeLease: undefined,
    updatedAt: loopNow(),
  };
  writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), cleared);
  if (newContainment) {
    recordLifecycleEvent(coordinationCwd, {
      event: "issue_contained",
      issueNumber,
      runId: state.runId,
      outcome: "recovered",
      reasonCode: failure.code,
      worktree: state.activeWorkspace,
      containment: {
        scope: "issue-local",
        stage: failure.stage,
        code: failure.code,
        paths: failure.paths,
        leaseReleased,
      },
    });
    await reportRuntimeFailure(coordinationCwd, {
      stage: `issue-containment:${failure.stage}`,
      category: "integrity",
      severity: "error",
      outcome: "recovered",
      code: "issue_contained",
      summary: reason,
      issueNumber,
      runId: state.runId,
      diagnosticRefs: failure.paths,
      diagnostic: { phase: failure.stage },
    });
    notifyLive(reason + " Continuing with the next eligible issue.", "warning");
  }
  return cleared;
}

export async function claimLoopIssue(
  cwd: string,
  state: LoopState,
  authorityOverride?: import("./issue-leases.ts").IssueLeaseAuthority,
  workAuthorityOverride?: import("../../src/coordination/work-authority.ts").WorkAuthorityAdapter,
): Promise<LoopState> {
  const hasPersistedExecutionState =
    state.activeIssueNumber !== undefined ||
    state.activeWorkspace !== undefined ||
    state.activeLease !== undefined;
  const hasCompleteExecutionState =
    typeof state.activeIssueNumber === "number" &&
    Number.isSafeInteger(state.activeIssueNumber) &&
    state.activeIssueNumber > 0 &&
    Boolean(state.activeWorkspace) &&
    Boolean(state.activeLease);
  if (hasPersistedExecutionState && !hasCompleteExecutionState) {
    throw new PlanAuthorityError(
      "unowned",
      "Persisted issue execution state is incomplete; refusing to infer ownership from a PLAN or partial loop state",
    );
  }
  if (hasCompleteExecutionState) {
    const activeIssueNumber = state.activeIssueNumber as number;
    const activeWorkspace = state.activeWorkspace as string;
    const activeLease = state.activeLease!;
    validateCanonicalExecutionState(activeWorkspace, state);
    const authority =
      authorityOverride ?? new GitHubIssueLeaseAuthority(cwd);
    // Reconcile live ownership before ensureIssueWorktree(): recovery may
    // create/repair the canonical worktree and must never happen for a fresh
    // foreign owner or a missing lease.
    const lease = await reconcileIssueLeaseForResume(
      authority,
      parseLeaseFromAuthority(JSON.stringify(activeLease)),
      new Date(),
    );
    let workspace: string;
    try {
      workspace = await ensureIssueWorktree(
        cwd,
        activeIssueNumber,
        recordLifecycleEvent,
      );
      if (workspace !== activeWorkspace) {
        throw new Error(
          `Persisted issue workspace mismatch: expected ${workspace}, found ${activeWorkspace}`,
        );
      }
      await quarantineInheritedArtifacts(cwd, workspace, activeIssueNumber, state.runId);
      await quarantineLegacyRootArtifacts(cwd, state.runId);
      await reconcileWorkspacePlan(workspace, activeIssueNumber, {
        runId: state.runId,
        authority: workAuthorityOverride,
      });
      validateWorkspacePlan(workspace, activeIssueNumber, { runId: state.runId });
    } catch (error) {
      throw new IssueHandoffError({
        issueNumber: activeIssueNumber,
        stage: "workspace-validation",
        workspace: activeWorkspace,
        lease,
        ownershipProven: true,
        cause: error,
      });
    }
    const next = {
      ...state,
      activeWorkspace: workspace,
      activeLease: lease,
      coordinationCwd: cwd,
      updatedAt: loopNow(),
    };
    writeJsonAtomic(loopStateFile(cwd, state.runId), next);
    return next;
  }

  // Production always uses the shared GitHub-backed authority; tests may
  // inject an in-memory authority to exercise this exact handoff sequence
  // without a live GitHub dependency.
  const authority = authorityOverride ?? new GitHubIssueLeaseAuthority(cwd);
  let issueNumber = state.activeIssueNumber;
  if (!issueNumber) {
    // The coordination checkout is never an issue-plan namespace. Candidate
    // selection comes from durable loop state and the live authority only;
    // any root PLAN/VERIFY is legacy/debris and is not ownership evidence.
    const shortlist = await candidateShortlist(cwd, {
      completedIssues: state.completedIssues,
      deferredIssues: state.deferredIssues.map((item) => item.issueNumber),
      leaseAuthority: authority,
    });
    if (shortlist.outcome === "unavailable") {
      throw new CandidateDiscoveryError(shortlist.reason || "authority query failed");
    }
    if (shortlist.outcome === "exhausted") {
      const exhausted: LoopState = {
        ...state,
        status: "idle",
        activeIssueNumber: undefined,
        activeWorkspace: undefined,
        activeLease: undefined,
        updatedAt: loopNow(),
        lastOutcome: "idle",
        lastReason: "No eligible autonomous issues remain after current-run exclusions.",
      };
      writeJsonAtomic(loopStateFile(cwd, state.runId), exhausted);
      return exhausted;
    }
    issueNumber = shortlist.candidateIssueNumber;
  }
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new CandidateDiscoveryError("authoritative shortlist did not include a valid issue identity");
  }
  const resolvedIssueNumber = issueNumber;

  const now = new Date();
  const lease = await claimIssueLease(
    authority,
    {
      issueNumber: resolvedIssueNumber,
      agent: "pi-next",
      runId: state.runId,
      sessionId: `${state.runId}-loop`,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ISSUE_LEASE_DURATION_MS,
      ).toISOString(),
    },
    now,
    { cwd, recordEvent: recordLifecycleEvent },
  );
  let workspace: string;
  try {
    workspace = await ensureIssueWorktree(cwd, resolvedIssueNumber, recordLifecycleEvent);
    await quarantineInheritedArtifacts(cwd, workspace, resolvedIssueNumber, state.runId);
    await quarantineLegacyRootArtifacts(cwd, state.runId);
    await reconcileWorkspacePlan(workspace, resolvedIssueNumber, {
      runId: state.runId,
      authority: workAuthorityOverride,
    });
    validateWorkspacePlan(workspace, resolvedIssueNumber, { runId: state.runId });
  } catch (error) {
    try {
      await releaseIssueLease(authority, lease, {
        cwd,
        recordEvent: recordLifecycleEvent,
      });
    } catch (releaseError) {
      throw new IssueHandoffError({
        issueNumber: resolvedIssueNumber,
        stage: "worktree-handoff",
        lease,
        leaseReleased: false,
        ownershipProven: false,
        cause: new Error(
          `Worktree handoff failed: ${error instanceof Error ? error.message : String(error)}; ` +
            `lease release also failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        ),
      });
    }
    throw new IssueHandoffError({
      issueNumber: resolvedIssueNumber,
      stage: "worktree-handoff",
      lease,
      leaseReleased: true,
      ownershipProven: false,
      cause: error,
    });
  }
  const next: LoopState = {
    ...state,
    coordinationCwd: cwd,
    activeIssueNumber: resolvedIssueNumber,
    activeWorkspace: workspace,
    activeLease: lease,
    updatedAt: loopNow(),
  };
  writeJsonAtomic(loopStateFile(cwd, state.runId), next);
  return next;
}

export async function removeCompletedWorkflowArtifacts(
  workspaceCwd: string,
  issueNumber: number,
): Promise<void> {
  const artifacts = workflowArtifacts(workspaceCwd);
  const plan = artifacts.find((artifact) => artifact.kind === "plan");
  if (plan) {
    throw new PlanAuthorityError(
      "unowned",
      `Cannot clean completed issue #${issueNumber} while PLAN remains active`,
      [plan.path],
    );
  }
  const verify = artifacts.find((artifact) => artifact.kind === "verify");
  if (!verify) return;
  if (verify.issueNumber !== issueNumber) {
    throw new PlanAuthorityError(
      "unowned",
      `Cannot clean issue #${issueNumber}: VERIFY.md belongs to #${verify.issueNumber || "unknown"}`,
      [verify.path],
    );
  }
  unlinkSync(verify.path);
  await commitExplicitPaths(
    workspaceCwd,
    [relative(workspaceCwd, verifyFile(workspaceCwd))],
    `chore(agent): remove completed issue #${issueNumber} verification artifact`,
    { issueNumber, kind: "lifecycle" },
  );
}

export async function quarantineLegacyRootArtifacts(
  coordinationCwd: string,
  runId: string,
): Promise<void> {
  const artifacts = quarantineLegacyCoordinationArtifacts(coordinationCwd);
  if (!artifacts.length) return;
  const paths = relativeWorkflowPaths(coordinationCwd, artifacts);
  const trackedPaths = artifacts.map((artifact) => relative(coordinationCwd, artifact.path));
  await commitExplicitPaths(
    coordinationCwd,
    trackedPaths,
    "chore(agent): quarantine legacy coordination workflow artifacts",
    { kind: "lifecycle", allowCoordinationMigration: true },
  );
  recordLifecycleEvent(coordinationCwd, {
    event: "workflow_artifact_quarantined",
    issueNumber: artifacts.find((artifact) => artifact.issueNumber)?.issueNumber || 0,
    runId,
    outcome: "recovered",
    reasonCode: "legacy_coordination_artifacts",
    repair: {
      paths,
      fields: artifacts.map((artifact) => `legacy-root:${artifact.kind}:${artifact.issueNumber ?? "unknown"}`),
    },
  });
}

export async function quarantineInheritedArtifacts(
  coordinationCwd: string,
  workspaceCwd: string,
  issueNumber: number,
  runId = "unknown",
): Promise<void> {
  const artifacts = quarantineInheritedWorkflowArtifacts(
    coordinationCwd,
    workspaceCwd,
    issueNumber,
  );
  if (!artifacts.length) return;
  const paths = relativeWorkflowPaths(workspaceCwd, artifacts);
  await commitExplicitPaths(
    workspaceCwd,
    paths,
    `chore(agent): quarantine inherited workflow artifacts for issue #${issueNumber}`,
    { issueNumber, kind: "lifecycle" },
  );
  recordLifecycleEvent(workspaceCwd, {
    event: "workflow_artifact_quarantined",
    issueNumber,
    runId,
    outcome: "recovered",
    reasonCode: "workflow_artifact_quarantined",
    repair: {
      paths,
      fields: artifacts.map((artifact) => `${artifact.kind}:${artifact.issueNumber ?? "unknown"}`),
    },
  });
}

export async function runOwnedIssueCycle(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  runtime: SupervisorRuntime = createSupervisorRuntime(),
  onWorkLog?: WorkerWorkLogSink,
  onWorkerState?: (runtime: import("./util-core.ts").IssueWorkerRuntime) => void,
): Promise<LoopState> {
  const coordinationCwd = initial.coordinationCwd || ctx.cwd;
  const display = attachWorkerDisplay(ctx);
  let state = initial;
  let prepared: LoopState;
  try {
    prepared = await claimLoopIssue(coordinationCwd, state);
  } catch (error) {
    const handoff = error instanceof IssueHandoffError ? error : undefined;
    const issueNumber = handoff?.issueNumber ?? state.activeIssueNumber;
    const classification = classifyFailure(error, {
      stage: handoff?.stage ?? "claim",
      issueNumber,
      workspace: handoff?.workspace ?? state.activeWorkspace,
      coordinationCwd,
      ownershipProven: handoff?.ownershipProven ?? false,
    });
    if (classification.scope === "issue-local") {
      return containIssueLocalFailure(coordinationCwd, state, classification, {
        lease: handoff?.lease as import("./issue-authority.ts").IssueLease | undefined,
        leaseReleased: handoff?.leaseReleased,
      });
    }
    const latest = readLoopState(coordinationCwd, state.runId);
    if (latest?.status === "running") {
      writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), {
        ...latest,
        status: "interrupted",
        updatedAt: loopNow(),
        lastReason: `Pi-next loop-global failure during ${classification.stage}: ${classification.reason}`,
      });
    }
    throw error;
  }
  state = prepared;
  // Candidate exhaustion is a normal terminal queue state. Do not enter the
  // worker controller after claim has durably settled the run as idle.
  if (prepared.status !== "running") return prepared;
  {
      const heartbeat = prepared.activeLease
        ? startIssueLeaseHeartbeat(
            new GitHubIssueLeaseAuthority(coordinationCwd),
            prepared.activeLease as import("./issue-authority.ts").IssueLease,
            {
              onRenew: (lease) => {
                const latest =
                  readLoopState(coordinationCwd, prepared.runId) || prepared;
                writeJsonAtomic(
                  loopStateFile(coordinationCwd, prepared.runId),
                  {
                    ...latest,
                    activeLease: lease,
                    updatedAt: loopNow(),
                  },
                );
              },
              onError: (error) =>
                notifyLive(
                  `Issue #${prepared.activeIssueNumber} lease renewal stopped: ${error instanceof Error ? error.message : String(error)}`,
                  "warning",
                ),
            },
          )
        : undefined;
      let containedFailure: FailureClassification | undefined;
      try {
        const targetCwd = prepared.activeWorkspace || coordinationCwd;
        if (prepared.activeWorkspace) {
          trackCrashLoggerCwd(prepared.activeWorkspace);
        }
        // Preserve child-process cwd isolation, but make every auto/resume/
        // maintenance model turn visibly alive in the interactive host.
        // `coordinationCwd` is threaded explicitly (#603) so the isolated
        // child's registered loop_result tool can resolve/validate the real
        // run authority via PI_NEXT_COORDINATION_CWD instead of depending on
        // a worktree-relative `.pi/runtime` path or symlink.
        const visibleWorker: IssueWorkerRunner = (
          workerCwd,
          prompt,
          options = {},
        ) =>
          runIssueWorker(workerCwd, prompt, {
            ...options,
            coordinationCwd: options.coordinationCwd ?? coordinationCwd,
            onActivity:
              options.onActivity ??
              ((event) => {
                if (runtime.currentGeneration()?.isDisposed()) return;
                display?.event(event);
                if (onWorkLog) onWorkLog(event);
                else notifyLive(workerActivityText(event), "info");
              }),
            onWorkerState: options.onWorkerState ?? onWorkerState,
            display: options.display ?? display,
            // The controller-owned footer renders elapsed worker time from
            // the live runtime. Do not emit heartbeat notifications into the
            // normal transcript.
            onProgress: options.onProgress,
            progressIntervalMs: options.progressIntervalMs ?? 10_000,
          });
        // A worker boundary is recoverable only while this issue's heartbeat
        // still owns the lease. Reconcile before releasing it, and always
        // return to this same issue; candidate selection happens below only
        // after the normal issue-boundary cleanup.
        const recoveryAuthority = new GitHubIssueLeaseAuthority(coordinationCwd);
        while (true) {
          await runLoopSteps(
            { ...ctx, cwd: targetCwd } as ExtensionCommandContext,
            state,
            visibleWorker,
            runtime,
            { onWorkerState, display },
          );
          state = readLoopState(coordinationCwd, prepared.runId) || state;
          if (!state.workerResultMissing || state.status !== "interrupted") break;
          const recovery = await reconcileMissingLoopResult(
            coordinationCwd,
            state,
            recoveryAuthority,
          );
          state = recovery.state;
          if (recovery.outcome !== "resuming_same_issue") break;
        }
      } catch (error) {
        const classification = classifyFailure(error, {
          stage: "execution",
          issueNumber: prepared.activeIssueNumber,
          workspace: prepared.activeWorkspace,
          coordinationCwd,
          ownershipProven: true,
        });
        if (classification.scope === "issue-local") {
          containedFailure = classification;
        } else {
        void reportRuntimeFailure(coordinationCwd, {
          stage: "controller",
          category: "runtime",
          severity: "error",
          outcome: "failed",
          code: "controller_failed",
          summary: error instanceof Error ? error.message : String(error),
          error,
          issueNumber: prepared.activeIssueNumber,
          runId: prepared.runId,
        });
        // runLoopSteps() acquires the controller lock as its first
        // synchronous action and truthfully interrupts/fails LoopState for
        // any error it observes afterward (see interruptLoop() in
        // loop-controller.ts). A failure before that point — e.g.
        // acquireControllerLock() itself throwing, or setup above it —
        // would otherwise never reach that handling and could leave the
        // just-claimed run stuck at status="running" forever (#603). Detect
        // exactly that gap (state still "running" after the throw) and
        // unwind it truthfully without touching the canonical worktree or
        // its issue-local runtime data; leave any state runLoopSteps already
        // made truthful untouched.
        const latest = readLoopState(coordinationCwd, prepared.runId);
        if (latest && latest.status === "running") {
          writeJsonAtomic(loopStateFile(coordinationCwd, prepared.runId), {
            ...latest,
            status: "interrupted",
            updatedAt: loopNow(),
            lastReason:
              `pi-next controller failed to start for issue ` +
              `#${prepared.activeIssueNumber ?? "?"}: ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              `Durable claim/worktree state was preserved; use ` +
              `/pi-next-loop resume once the underlying failure is resolved.`,
          });
        }
        throw error;
        }
      } finally {
        await heartbeat?.stop();
        if (!containedFailure && heartbeat && prepared.activeIssueNumber) {
          try {
            await releaseIssueLease(
              new GitHubIssueLeaseAuthority(coordinationCwd),
              heartbeat.getLease(),
              { cwd: coordinationCwd, recordEvent: recordLifecycleEvent },
            );
          } catch (error) {
            notifyLive(
              `Issue #${prepared.activeIssueNumber} lease release failed: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
        trackCrashLoggerCwd(coordinationCwd);
      }

      if (containedFailure) {
        const latest = readLoopState(coordinationCwd, prepared.runId) || state;
        return containIssueLocalFailure(coordinationCwd, latest, containedFailure, {
          lease: prepared.activeLease
            ? parseLeaseFromAuthority(JSON.stringify(prepared.activeLease))
            : undefined,
        });
      }
      state = readLoopState(coordinationCwd, prepared.runId) || prepared;
      // Boundary publication is deliberately after the issue worker and before
      // candidate selection. It is thresholded, deduplicated, and held by the
      // authority; a failed authority call cannot affect issue finalization.
      try {
        const assessmentConfig = loadPiNextConfig(coordinationCwd);
        const assessmentAuthority = createWorkAuthority(coordinationCwd, assessmentConfig);
        await publishSelfAssessmentFindings(coordinationCwd, assessmentAuthority, assessmentConfig);
        await refreshFindingApprovals(coordinationCwd, assessmentAuthority, assessmentConfig);
      } catch {
        // Self-assessment is diagnostic and must never take ownership of the
        // product lifecycle or turn a clean issue boundary into a failure.
      }
      if (
        state.lastOutcome === "archived" &&
        prepared.activeIssueNumber &&
        prepared.activeWorkspace
      ) {
        try {
          await removeCompletedWorkflowArtifacts(
            prepared.activeWorkspace,
            prepared.activeIssueNumber,
          );
          await cleanupCompletedIssueWorktree(
            coordinationCwd,
            prepared.activeWorkspace,
            prepared.activeIssueNumber,
          );
        } catch (error) {
          const blocked: LoopState = {
            ...state,
            status: "blocked",
            updatedAt: loopNow(),
            lastReason:
              error instanceof Error
                ? error.message
                : String(error),
          };
          writeJsonAtomic(loopStateFile(coordinationCwd, prepared.runId), blocked);
          // Fires after runLoopSteps() has returned, i.e. after any internal
          // ctx.newSession() transitions already invalidated the outer `ctx`
          // this function was called with (#616) — resolve live ctx instead.
          notifyLive(blocked.lastReason || "Issue workspace cleanup failed", "warning");
          return blocked;
        }
      }
      if (state.status !== "running" || state.remainingIssues <= 0) return state;
      // The issue boundary is now clean and coordination-only. Do not let the
      // next candidate inherit the completed issue's lease or workspace.
      state = {
        ...state,
        activeIssueNumber: undefined,
        activeWorkspace: undefined,
        activeLease: undefined,
        updatedAt: loopNow(),
      };
      writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), state);
      return state;
  }
}

/**
 * Compatibility wrapper for callers that still need to run the complete
 * issue-selection loop. ForegroundSupervisor owns this progression in auto;
 * this wrapper remains for direct loop-controller tests and integrations.
 */
export async function runOwnedLoopSteps(
  ctx: ExtensionCommandContext,
  initial: LoopState,
  runtime: SupervisorRuntime = createSupervisorRuntime(),
): Promise<void> {
  let state = initial;
  while (true) {
    state = await runOwnedIssueCycle(ctx, state, runtime);
    if (state.status !== "running" || state.remainingIssues <= 0) return;
  }
}

/**
 * The loop controller keeps coordination state in the parent process/session
 * (durable loop-state, lease, and worktree bookkeeping); each bounded auto
 * step still runs in an isolated issue worker — a dedicated child process
 * spawned by `runIssueWorker` (util-core.ts) — never inline in the parent.
 * `/pi-next auto`/`resume` drive this through `ForegroundSupervisor.launch`
 * (#612), which owns that isolated-worker cycle end to end.
 */
export async function runPiNextLoop(
  args: string,
  ctx: ExtensionCommandContext,
  onWorkLog?: WorkerWorkLogSink,
  onWorkerState?: (runtime: import("./util-core.ts").IssueWorkerRuntime) => void,
): Promise<void> {
  const [command, requestedRunId] = args.trim().split(/\s+/, 2);
  const input = (command || "").toLowerCase();
  const runs = listLoopStates(ctx.cwd);
  const selectRun = (
    predicate: (state: LoopState) => boolean,
  ): LoopState | null => {
    const matches = runs.filter(predicate);
    if (requestedRunId) return readLoopState(ctx.cwd, requestedRunId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      notifySafely(
        ctx,
        `Multiple pi-next runs are eligible; specify a run ID: ${matches.map((run) => run.runId).join(", ")}`,
        "warning",
      );
    }
    return null;
  };
  if (input === "clear") {
    // Clearing the footer is deliberately explicit. Ordinary auto command
    // completion leaves the latest durable controller state visible.
    ctx.ui.setStatus(AUTO_STATUS_KEY, undefined);
    return;
  }
  if (input === "status") {
    if (requestedRunId)
      notifyLoopState(ctx, readLoopState(ctx.cwd, requestedRunId));
    else if (runs.length)
      notifySafely(
        ctx,
        runs
          .map(
            (run) =>
              `${run.runId}: ${run.status}, issue progress ${run.completedIssues.length}/${run.requestedIssues}`,
          )
          .join("\n"),
        "info",
      );
    else notifySafely(ctx, "No pi-next loop runs found.", "info");
    return;
  }
  if (input === "stop") {
    const current = selectRun((state) => state.status === "running");
    if (!current || current.status !== "running") {
      notifySafely(
        ctx,
        "No uniquely selected running pi-next loop; specify its run ID when multiple runs exist.",
        "info",
      );
      return;
    }
    const next: LoopState = {
      ...current,
      stopRequested: true,
      updatedAt: loopNow(),
      lastReason: "Stop requested by user",
    };
    writeJsonAtomic(loopStateFile(ctx.cwd, current.runId), next);
    notifySafely(
      ctx,
      "Pi loop will stop at the next clean step boundary.",
      "info",
    );
    return;
  }

  await ctx.waitForIdle();
  if (input === "resume") {
    const current = requestedRunId
      ? readLoopState(ctx.cwd, requestedRunId)
      : selectRun((state) => ["interrupted", "stopped"].includes(state.status));
    if (
      !current ||
      current.remainingIssues <= 0 ||
      !["interrupted", "stopped"].includes(current.status)
    ) {
      notifySafely(
        ctx,
        "No interrupted or stopped pi-next loop is available.",
        "warning",
      );
      return;
    }

    const pendingResult = existsSync(loopResultFile(ctx.cwd, current.runId));
    let settledStep = current.settledStep;
    if (!pendingResult && current.step > current.settledStep) {
      const boundary = await safeLoopBoundary(ctx.cwd, false);
      if (!boundary.safe) {
        notifySafely(
          ctx,
          `Cannot resume unattended loop from unsafe state: ${boundary.reason}`,
          "warning",
        );
        return;
      }
      settledStep = current.step;
    }

    const resumed: LoopState = {
      ...current,
      sessionId: current.sessionId || sessionIdentity(ctx),
      settledStep,
      status: "running",
      stopRequested: false,
      updatedAt: loopNow(),
      lastReason: "Resumed by user from a clean boundary",
    };
    writeJsonAtomic(loopStateFile(ctx.cwd, resumed.runId), resumed);
    await new ForegroundSupervisor(ctx, onWorkLog, onWorkerState).launch(resumed);
    return;
  }

  const requestedIssues = parseLoopLimit(input);
  const createdAt = loopNow();
  const state: LoopState = {
    version: 1,
    runId: `${createdAt.replace(/[:.]/g, "-")}-${process.pid}`,
    sessionId: sessionIdentity(ctx),
    requestedIssues,
    remainingIssues: requestedIssues,
    step: 0,
    settledStep: 0,
    maxSteps: Math.min(MAX_STEPS, Math.max(10, requestedIssues * 20)),
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt,
    updatedAt: createdAt,
    metrics: emptyLoopMetrics(),
    coordinationCwd: ctx.cwd,
  };
  writeJsonAtomic(loopStateFile(ctx.cwd, state.runId), state);
  await new ForegroundSupervisor(ctx, onWorkLog, onWorkerState).launch(state);
}

export function registerPiNextLoopCommand(
  pi: ExtensionAPI,
  onWorkLog: WorkerWorkLogSink = (event) => appendWorkerNarrative(pi, event),
): void {
  pi.registerCommand("pi-next-loop", {
    description:
      "Run token-bounded GitHub issue work with iterative fresh-session batches, issue deferral, reload recovery, and bounded same-issue reuse",
    handler: async (args, ctx) => {
      try {
        await runPiNextLoop(args, ctx, onWorkLog);
      } catch (error) {
        // Loop startup runs in the extension host. Keep failures such as
        // stale controller locks, malformed persisted state, or worktree
        // setup errors from becoming unhandled rejections that unload pi.
        notifySafely(
          ctx,
          `pi-next loop failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

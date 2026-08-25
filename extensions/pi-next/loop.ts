import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, unlinkSync } from "node:fs";
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
  CandidateDiscoveryError,
  candidateShortlist,
} from "./issue-candidates.ts";
import { getLiveIssueFingerprint } from "./issue-freshness.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { recordPiLifecycleJournal } from "./lifecycle-journal.ts";
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
  LeaseConflictError,
  ISSUE_LEASE_DURATION_MS,
  type IssueLease,
  releaseIssueLease,
  reconcileIssueLeaseForResume,
  parseLeaseFromAuthority,
  startIssueLeaseHeartbeat,
} from "./issue-leases.ts";
import {
  emptyLoopMetrics,
  loopNow,
  listLoopStates,
  loopStateFile,
  markIssueDisposition,
  MAX_STEPS,
  parseLoopLimit,
  readLoopState,
  type LoopState,
  type LoopStatus,
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
import type { IssueWorkerRunner } from "./util-core.ts";
import {
  PiWorkerAdapter,
  issueWorkerRunnerFromAdapter,
  type PiWorkerCompatibleAdapter,
} from "./pi-worker-adapter.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";
import { appendWorkerNarrative, type WorkerWorkLogSink } from "./work-log.ts";
import { attachWorkerDisplay, type WorkerDisplayController } from "./worker-display.ts";
import { bindLiveAutoRun, getLiveCtx, getLiveCtxForRun, sessionIdentity } from "./live-ctx.ts";
import { renderLoopStatus, type IdentityMismatchDetails } from "./loop-status.ts";
import {
  createControllerIdentityMismatchIncident,
  readLastIncidentBundle,
  reportIncidentBundle,
} from "../../src/coordination/incident-reporting.ts";
import { commitIncidentDiagnosticsBeforeFinalization } from "../../src/coordination/post-integration-reverification.ts";
import { runCommand } from "../../src/bootstrap/command-runner.ts";
import { issueLeaseMatchesOwner } from "./issue-authority.ts";
import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { createWorkAuthority } from "../../src/coordination/work-authority.ts";
import {
  preflightWorkflowStateProvider,
  WorkflowStateProviderError,
} from "./workflow-state-provider.ts";
import { publishSelfAssessmentFindings, refreshFindingApprovals } from "./self-assessment.ts";
import { runProductionLifecycleScheduler } from "./production-lifecycle.ts";
import { abortRun, registerRunAbortController } from "./run-cancellation.ts";

export { MAX_ISSUES, readLoopState, writeLoopResult } from "./loop-state.ts";
export type { LoopOutcome, LoopResult, LoopState } from "./loop-state.ts";

const AUTO_STATUS_KEY = "pi-next-auto";

// The retired loop-controller.ts state machine is the only writer of
// "interrupted"/"stopped" (loop.ts:291/860/1043, loop-controller.ts). The
// unified scheduler (production-lifecycle.ts) never writes either — a
// stopped/aborted fresh run settles as "cancelled" instead. These two lists
// are therefore a reliable structural discriminator between legacy
// pre-migration state and unified-scheduler-produced state (issue #165).
const LEGACY_RESUMABLE_STATUSES: readonly LoopStatus[] = ["interrupted", "stopped"];
const UNIFIED_RESUMABLE_STATUSES: readonly LoopStatus[] = ["cancelled"];
const RESUMABLE_STATUSES: readonly LoopStatus[] = [...LEGACY_RESUMABLE_STATUSES, ...UNIFIED_RESUMABLE_STATUSES];

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
 * — a captured `ctx` is not safe to use directly across a genuine host
 * lifecycle replacement (#616). These callbacks resolve the actually-live
 * ctx through the registry in `live-ctx.ts`; ordinary worker batches keep
 * the original host session unchanged. A missing live ctx (no command has
 * attached one yet, or the run has no UI) is a silent no-op, matching
 * `safeNotify`'s existing "diagnostic only" contract.
 */
async function authoritativeStatusRun(
  cwd: string,
): Promise<{ authoritativeRunId?: string; authorityUnavailable: boolean }> {
  // `activeLease` is only ever populated by the legacy loop-controller path
  // (#165 migration); the unified scheduler (production-lifecycle.ts) claims
  // per-issue leases through the shared kernel and never mirrors them onto
  // the persisted LoopState. Requiring `activeLease` here would silently
  // exclude every fresh-scheduler run from authoritative resolution, so the
  // Campsty #647/#640 contradiction guard would never fire for them (#166).
  const candidates = listLoopStates(cwd)
    .filter((state) => state.activeIssueNumber)
    .slice(0, 20);
  if (!candidates.length) return { authorityUnavailable: false };
  const authority = new GitHubIssueLeaseAuthority(cwd);
  let unavailable = false;
  for (const state of candidates) {
    try {
      const lease = await authority.read(state.activeIssueNumber!);
      // A fresh-scheduler run never persisted its own lease identity locally,
      // so its expected identity is reconstructed from the same convention
      // `runProductionLifecycleScheduler`'s `claim` uses when it calls
      // `claimIssueLease` (production-lifecycle.ts), instead of trusting a
      // legacy `activeLease` field that run never wrote.
      const expected: Pick<IssueLease, "issueNumber" | "agent" | "runId" | "sessionId"> = state.activeLease
        ? (state.activeLease as IssueLease)
        : {
            issueNumber: state.activeIssueNumber!,
            agent: "pi-next",
            runId: `${state.runId}:issue-${state.activeIssueNumber}`,
            sessionId: `${state.runId}-issue-${state.activeIssueNumber}`,
          };
      if (lease && issueLeaseMatchesOwner(lease, expected)) {
        return { authoritativeRunId: state.runId, authorityUnavailable: false };
      }
    } catch {
      unavailable = true;
    }
  }
  return { authorityUnavailable: unavailable };
}

/**
 * Persist/report the Campsty #647/#640-shape controller/footer identity
 * contradiction as a framework incident (#145). Debounced against the last
 * persisted local bundle so repeated status polls against an unresolved
 * contradiction do not spam a fresh incident file/commit on every call;
 * GitHub-side dedupe (existing open-issue occurrence append) still applies
 * once persisted.
 */
export function reportIdentityMismatch(cwd: string, details: IdentityMismatchDetails): void {
  try {
    const last = readLastIncidentBundle(cwd);
    if (
      last?.failure.code === "CONTROLLER_IDENTITY_MISMATCH" &&
      last.identityMismatch?.activeRunId === details.activeRunId &&
      last.identityMismatch?.footerRunId === details.footerRunId
    ) {
      return;
    }
    const config = loadPiNextConfig(cwd);
    const bundle = createControllerIdentityMismatchIncident({
      cwd,
      activeIssue: details.activeIssue,
      activeRunId: details.activeRunId,
      footerIssue: details.footerIssue,
      footerRunId: details.footerRunId,
      reason: details.reason,
    });
    void reportIncidentBundle(cwd, bundle, {
      config,
      github: config.incidentReporting.autoCreateFrameworkIncidents && bundle.classification.reportability === "upstream",
    })
      .then(() => commitIncidentDiagnosticsBeforeFinalization({ root: cwd, runCommand }))
      .catch(() => {
        // Incident capture/reporting is observational and must never affect status rendering.
      });
  } catch {
    // Incident capture/reporting is observational and must never affect status rendering.
  }
}

function notifyLive(
  message: string,
  level: "info" | "warning" | "error" = "info",
  runId?: string,
): void {
  const ctx = runId ? getLiveCtxForRun(runId) ?? getLiveCtx() : getLiveCtx();
  if (!ctx) return;
  safeNotify(ctx, message, level);
}

/**
 * Resolve the host context for a replacement worker after a session boundary.
 * The captured command context is deliberately not a fallback here: using it
 * would turn a disposed session into a silent replacement-worker failure.
 */
export function replacementWorkerContext(issueNumber?: number, runId?: string): ExtensionCommandContext {
  const live = (runId ? getLiveCtxForRun(runId) : undefined) ?? getLiveCtx();
  if (!live) {
    throw new Error(
      `Replacement worker startup failed for issue #${issueNumber ?? "?"}: no live host context is available after missing-result recovery`,
    );
  }
  return live;
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
    // The failed worker turn has been durably classified and must not be
    // replayed when the next issue is selected.
    settledStep: Math.max(state.settledStep, state.step),
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
    notifyLive(reason + " Continuing with the next eligible issue.", "warning", state.runId);
  }
  return cleared;
}

async function yieldClaimedIssue(
  cwd: string,
  state: LoopState,
  issueNumber: number,
  lease: IssueLease,
  reason: string,
  authority: import("./issue-leases.ts").IssueLeaseAuthority,
): Promise<LoopState> {
  await releaseIssueLease(authority, lease, {
    cwd,
    recordEvent: recordLifecycleEvent,
  });
  const yieldedAt = loopNow();
  const yielded: LoopState = {
    ...state,
    status: "running",
    activeIssueNumber: undefined,
    activeWorkspace: undefined,
    activeLease: undefined,
    deferredIssues: [
      ...state.deferredIssues.filter((item) => item.issueNumber !== issueNumber),
      { issueNumber, reason, deferredAt: yieldedAt, kind: "yielded" },
    ],
    issueMetrics: markIssueDisposition(state.issueMetrics, issueNumber, "yielded", reason),
    lastOutcome: "yield_issue",
    lastReason: `Yielded issue #${issueNumber}: ${reason}`,
    updatedAt: yieldedAt,
  };
  writeJsonAtomic(loopStateFile(cwd, state.runId), yielded);
  notifyLive(yielded.lastReason || `Issue #${issueNumber} yielded`, "warning", state.runId);
  return yielded;
}

async function readIssueEligibility(
  cwd: string,
  issueNumber: number,
  authority: import("../../src/coordination/work-authority.ts").WorkAuthorityAdapter,
): Promise<{ eligible: boolean; reason: string; disposition: string }> {
  try {
    const live = await getLiveIssueFingerprint(cwd, issueNumber, authority);
    return live.eligibility;
  } catch {
    return {
      eligible: false,
      disposition: "unavailable",
      reason: "authority eligibility could not be verified",
    };
  }
}

export async function claimLoopIssue(
  cwd: string,
  state: LoopState,
  authorityOverride?: import("./issue-leases.ts").IssueLeaseAuthority,
  workAuthorityOverride?: import("../../src/coordination/work-authority.ts").WorkAuthorityAdapter,
  onStatus?: (message: string) => void,
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
      { cwd, recordEvent: recordLifecycleEvent },
    );
    // An injected work authority is used by harnesses to make this claim
    // boundary independently testable. Production's active-plan gate below
    // performs the same read through the configured authority before a worker.
    if (workAuthorityOverride) {
      const eligibility = await readIssueEligibility(cwd, activeIssueNumber, workAuthorityOverride);
      if (!eligibility.eligible) {
        return yieldClaimedIssue(
          cwd,
          state,
          activeIssueNumber,
          lease,
          `authority now ${eligibility.disposition}: ${eligibility.reason}`,
          authority,
        );
      }
    }
    let workspace: string;
    try {
      workspace = await ensureIssueWorktree(
        cwd,
        activeIssueNumber,
        recordLifecycleEvent,
        { ownership: { lease, authority } },
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
      // Missing task Files/Approach is a bounded planning defect after
      // canonical ownership has been proven; the worker gets one repair turn
      // instead of this handoff containing an otherwise ready issue.
      validateWorkspacePlan(workspace, activeIssueNumber, {
        runId: state.runId,
        allowTaskMetadata: true,
      });
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
  // A fresh-owner conflict while selecting new work is a normal scheduler
  // race. Keep retrying selection in this same call, while persisted active
  // issue recovery above remains deliberately fail-closed.
  while (true) {
  let issueNumber = state.activeIssueNumber;
  if (!issueNumber) {
    // The coordination checkout is never an issue-plan namespace. Candidate
    // selection comes from durable loop state and the live authority only;
    // any root PLAN/VERIFY is legacy/debris and is not ownership evidence.
    const shortlist = await candidateShortlist(cwd, {
      authority: workAuthorityOverride,
      completedIssues: state.completedIssues,
      deferredIssues: state.deferredIssues.map((item) => item.issueNumber),
      schedulerExcludedIssues: (state.schedulerSkips || []).map((item) => item.issueNumber),
      leaseAuthority: authority,
      onStatus,
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
  let lease: IssueLease;
  try {
    lease = await claimIssueLease(
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
  } catch (error) {
    if (!(error instanceof LeaseConflictError)) throw error;
    const skippedAt = loopNow();
    const reason = `Issue #${resolvedIssueNumber} skipped: leased elsewhere (fresh_owner)`;
    const skipped = {
      ...state,
      schedulerSkips: [
        ...(state.schedulerSkips || []).filter((item) => item.issueNumber !== resolvedIssueNumber),
        {
          issueNumber: resolvedIssueNumber,
          reasonCode: "fresh_owner" as const,
          reason,
          skippedAt,
        },
      ].slice(-100),
      issueMetrics: markIssueDisposition(
        state.issueMetrics,
        resolvedIssueNumber,
        "leased_elsewhere",
        reason,
      ),
      lastOutcome: "yield_issue" as const,
      lastReason: reason,
      updatedAt: skippedAt,
    };
    writeJsonAtomic(loopStateFile(cwd, state.runId), skipped);
    recordLifecycleEvent(cwd, {
      event: "scheduler_skip",
      issueNumber: resolvedIssueNumber,
      runId: state.runId,
      outcome: "skip",
      reasonCode: "fresh_owner",
    });
    notifyLive(reason, "warning", state.runId);
    state = skipped;
    continue;
  }
  // A selected issue is revalidated before worktree handoff whenever the
  // host supplies the configured authority. The active-plan gate is still
  // mandatory immediately before any worker transition.
  if (workAuthorityOverride) {
    const eligibility = await readIssueEligibility(cwd, resolvedIssueNumber, workAuthorityOverride);
    if (!eligibility.eligible) {
      return yieldClaimedIssue(
        cwd,
        state,
        resolvedIssueNumber,
        lease,
        `authority now ${eligibility.disposition}: ${eligibility.reason}`,
        authority,
      );
    }
  }
  let workspace: string;
  try {
    workspace = await ensureIssueWorktree(
      cwd,
      resolvedIssueNumber,
      recordLifecycleEvent,
      { ownership: { lease, authority } },
    );
    await quarantineInheritedArtifacts(cwd, workspace, resolvedIssueNumber, state.runId);
    await quarantineLegacyRootArtifacts(cwd, state.runId);
    await reconcileWorkspacePlan(workspace, resolvedIssueNumber, {
      runId: state.runId,
      authority: workAuthorityOverride,
    });
    validateWorkspacePlan(workspace, resolvedIssueNumber, {
      runId: state.runId,
      allowTaskMetadata: true,
    });
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
    planRepair: undefined,
    updatedAt: loopNow(),
  };
  writeJsonAtomic(loopStateFile(cwd, state.runId), next);
  return next;
  }
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
  const verifyText = readFileSync(verifyFile(workspaceCwd), "utf8");
  const authorityFingerprint = verifyText.match(/^ISSUE_FINGERPRINT:\s*(\S+)$/m)?.[1];
  unlinkSync(verify.path);
  await commitExplicitPaths(
    workspaceCwd,
    [relative(workspaceCwd, verifyFile(workspaceCwd))],
    `chore(agent): remove completed issue #${issueNumber} verification artifact`,
    {
      issueNumber,
      kind: "lifecycle",
      ...(authorityFingerprint
        ? {
            correctness: {
              reason: "post_integration_cleanup" as const,
              fingerprint: authorityFingerprint,
            },
          }
        : {}),
    },
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

/**
 * The loop controller keeps coordination state in the parent process/session
 * (durable loop-state, lease, and worktree bookkeeping); each bounded auto
 * step still runs in an isolated issue worker through the harness-neutral
 * WorkerAdapter boundary. PiWorkerAdapter is the current default and delegates
 * to the proven isolated child-process runner — never inline in the parent.
 * `/pi-next auto`/`resume` drive this through the unified scheduler
 * (production-lifecycle.ts, #165), which owns that isolated-worker cycle end
 * to end; the retired ForegroundSupervisor/loop-controller.ts state machine
 * no longer exists.
 */
export async function runPiNextLoop(
  args: string,
  ctx: ExtensionCommandContext,
  onWorkLog?: WorkerWorkLogSink,
  onWorkerState?: (runtime: import("./util-core.ts").IssueWorkerRuntime) => void,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0];
  const requestedRunId = tokens[1];
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
    const mode = requestedRunId === "verbose" || requestedRunId === "history" || requestedRunId === "all"
      ? "verbose"
      : "summary";
    const explicitRunId = mode === "verbose" ? tokens[2] : requestedRunId;
    const authority = await authoritativeStatusRun(ctx.cwd);
    notifySafely(
      ctx,
      renderLoopStatus(ctx.cwd, sessionIdentity(ctx), explicitRunId, mode, {
        ...authority,
        onIdentityMismatch: (details) => reportIdentityMismatch(ctx.cwd, details),
      }),
      "info",
    );
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
    // `stopRequested` above is the durable, cross-process stop signal a
    // legacy loop-controller run polls at its next step boundary. A fresh
    // unified-scheduler run registers an in-process AbortController for its
    // runId (see below); abort it directly so the scheduler's signal.aborted
    // checks can exit immediately instead of waiting on file polling.
    const abortedInProcess = abortRun(current.runId, "Stop requested by user");
    notifySafely(
      ctx,
      abortedInProcess
        ? "Pi loop is stopping now."
        : "Pi loop will stop at the next clean step boundary.",
      "info",
    );
    return;
  }

  // Validate provider configuration and, for explicit helpers, their output
  // before writing a new run state, claiming an issue, or launching a worker.
  // Status/stop/clear are intentionally diagnostic/control-only paths and do
  // not need the autonomous-entry preflight.
  await preflightWorkflowStateProvider(ctx.cwd);
  await ctx.waitForIdle();
  if (input === "resume") {
    const current = requestedRunId
      ? readLoopState(ctx.cwd, requestedRunId)
      : selectRun((state) => RESUMABLE_STATUSES.includes(state.status));
    if (
      !current ||
      current.remainingIssues <= 0 ||
      !RESUMABLE_STATUSES.includes(current.status)
    ) {
      notifySafely(
        ctx,
        "No interrupted, stopped, or cancelled pi-next loop is available.",
        "warning",
      );
      return;
    }

    if (LEGACY_RESUMABLE_STATUSES.includes(current.status)) {
      // Legacy pre-migration state was produced by the retired
      // loop-controller.ts/ForegroundSupervisor state machine, which no
      // longer runs (issue #165). Its shape (step/settledStep bookkeeping,
      // activeLease, planRepair, ...) was never designed to be read by the
      // unified scheduler, so it is rejected explicitly with actionable
      // guidance rather than silently misinterpreted or launched through a
      // state machine that is being retired.
      notifySafely(
        ctx,
        `Run ${current.runId} is legacy pre-migration state (status "${current.status}") and can no longer be resumed automatically. ` +
          `Inspect it with "/pi-next-loop status ${current.runId} verbose", then either finish any in-progress work manually or discard the run and start a fresh "/pi-next auto" (the retired ForegroundSupervisor/loop-controller.ts state machine can no longer resume it).`,
        "warning",
      );
      return;
    }

    // Unified-scheduler-produced state (status "cancelled"): continue it
    // through the same shared scheduler entry point fresh `/pi-next auto`
    // uses, with a fresh in-process AbortController, instead of the retired
    // ForegroundSupervisor.
    bindLiveAutoRun(ctx, current.runId);
    const controller = new AbortController();
    const unregister = registerRunAbortController(current.runId, controller);
    try {
      await runProductionLifecycleScheduler({
        cwd: ctx.cwd,
        ctx,
        entry: "auto",
        requestedIssues: current.remainingIssues,
        runId: current.runId,
        onWorkLog,
        onWorkerState,
        signal: controller.signal,
      });
    } finally {
      unregister();
    }
    return;
  }

  const requestedIssues = parseLoopLimit(input);
  const createdAt = loopNow();
  const runId = `${createdAt.replace(/[:.]/g, "-")}-${process.pid}`;
  // New auto execution is queue scheduling over the shared lifecycle kernel;
  // it never enters the retired ForegroundSupervisor/loop-controller.ts
  // worker/repair/finalization state machine (issue #165).
  bindLiveAutoRun(ctx, runId);
  const controller = new AbortController();
  const unregister = registerRunAbortController(runId, controller);
  try {
    await runProductionLifecycleScheduler({
      cwd: ctx.cwd,
      ctx,
      entry: "auto",
      requestedIssues,
      runId,
      onWorkLog,
      onWorkerState,
      signal: controller.signal,
    });
  } finally {
    unregister();
  }
}

export function registerPiNextLoopCommand(
  pi: ExtensionAPI,
  onWorkLog: WorkerWorkLogSink = (event) => appendWorkerNarrative(pi, event),
): void {
  pi.registerCommand("pi-next-loop", {
    description:
      "Run token-bounded GitHub issue work with isolated fresh-worker turns, issue deferral, reload recovery, and bounded same-issue reuse",
    handler: async (args, ctx) => {
      try {
        await runPiNextLoop(args, ctx, onWorkLog);
      } catch (error) {
        // Loop startup runs in the extension host. Keep failures such as
        // stale controller locks, malformed persisted state, or worktree
        // setup errors from becoming unhandled rejections that unload pi.
        notifySafely(
          ctx,
          `${error instanceof WorkflowStateProviderError ? "Workflow state provider preflight failed" : "pi-next loop failed"}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

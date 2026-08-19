import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

import { currentPlanIssue } from "./auto-telemetry.ts";
import { trackCrashLoggerCwd } from "./crash-log.ts";
import { candidateShortlist } from "./issue-candidates.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import {
  currentGeneration,
  currentSupervisorStatus,
  formatSupervisorStatus,
} from "./foreground-supervisor.ts";
import {
  cleanupCompletedIssueWorktree,
} from "./main-refresh.ts";
import {
  GitHubIssueLeaseAuthority,
  claimIssueLease,
  ensureIssueWorktree,
  releaseIssueLease,
  LeaseConflictError,
  ISSUE_LEASE_DURATION_MS,
  startIssueLeaseHeartbeat,
  type IssueLease,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import {
  quarantineInheritedArtifacts,
  registerPiNextLoopCommand,
  removeCompletedCoordinationArtifacts,
  removeCompletedWorkflowArtifacts,
  runPiNextLoop,
  MAX_ISSUES,
} from "./loop.ts";
import { workflowArtifacts } from "./plan-read.ts";
import { buildPiNextPrompt } from "./prompt.ts";
import {
  changeFiles,
  guardedHostCall,
  markerFile,
  parseState,
  PlanAuthorityError,
  planFile,
  resolvePlanIdentity,
  runHelper,
  safeNotify,
} from "./util.ts";
import {
  runIssueWorker,
  type IssueWorkerOptions,
  type IssueWorkerRunner,
} from "./util-core.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";
import { appendWorkerWorkLog, type WorkerWorkLogSink } from "./work-log.ts";
import { attachWorkerDisplay } from "./worker-display.ts";

/**
 * Delivers through the shared lifecycle-aware host boundary (#583) instead
 * of duplicating the try/catch-rejection contract locally. This command-level
 * notification is not itself owned by a specific extension generation (it
 * can fire before any generation exists, e.g. on a claim/worktree failure),
 * so it does not gate on the shared `currentGeneration()` singleton — doing
 * so would incorrectly suppress delivery based on an unrelated generation's
 * disposal elsewhere in the process.
 */
function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  safeNotify(ctx, message, level);
}

/**
 * Exported for regression testing of the generation-disposed follow-up gate
 * (#583); not part of the extension's public command surface.
 */
export function sendPiNextPrompt(
  pi: ExtensionAPI,
  cwd: string,
  args: string,
  deliverAs?: "followUp",
): void {
  // Route through the shared lifecycle-aware host boundary so a
  // synchronous/async host-teardown rejection during delivery can never
  // escape as an unhandled rejection (#583). Also gate on the current
  // generation's disposed state so a prompt queued (deliverAs: "followUp")
  // before a generation is torn down/replaced is suppressed instead of
  // being delivered into a replacement session.
  const isDisposed = () => currentGeneration()?.isDisposed() ?? false;
  guardedHostCall(isDisposed, () =>
    pi.sendUserMessage(
      buildPiNextPrompt(cwd, args),
      deliverAs ? { deliverAs } : undefined,
    ),
  );
}

interface ClaimedIssueWorkspace {
  leaseAuthority: IssueLeaseAuthority;
  claimedLease: IssueLease;
  executionCwd: string;
}

async function executeIssueWorker(
  cwd: string,
  prompt: string,
  runner: IssueWorkerRunner = runIssueWorker,
  onProgress?: (elapsedMs: number) => void,
  observer?: Pick<IssueWorkerOptions, "issueNumber" | "runId" | "phase" | "onActivity" | "onWorkerState" | "display">,
): Promise<void> {
  const generation = currentGeneration();
  const task = runner(cwd, prompt, {
    signal: generation?.signal,
    onProgress,
    ...observer,
  });
  const result = generation
    ? await generation.track(task, { kind: "subprocess" })
    : await task;
  if (!result.ok) {
    const detail = result.output.trim().slice(-1_000);
    throw new Error(
      `Issue worker failed (${result.signal || `exit ${result.code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/**
 * Claim an issue lease and resolve/attach its canonical worktree, mirroring
 * the auto/explicit claim -> ensureIssueWorktree sequence so plain and
 * "fresh" pi-next invocations never mutate the shared coordination checkout.
 * Candidate resolution prefers an existing PLAN's GitHub-Issue, then an
 * explicit issue number in args, then the live shortlist (same as auto).
 */
async function claimAndAttachIssueWorkspace(
  coordinationCwd: string,
  args: string,
  authorityOverride?: IssueLeaseAuthority,
): Promise<ClaimedIssueWorkspace | undefined> {
  // Production always uses the shared GitHub-backed authority; tests may
  // inject an in-memory authority to exercise this exact handoff sequence
  // without a live GitHub dependency.
  const leaseAuthority =
    authorityOverride ?? new GitHubIssueLeaseAuthority(coordinationCwd);
  const plan = resolvePlanIdentity(coordinationCwd);
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
  const planBefore = plan.kind === "resolved";
  const issueBefore =
    plan.kind === "resolved"
      ? plan.issueNumber
      : currentPlanIssue(coordinationCwd);
  const argsIssueMatch = args.trim().match(/#?(\d+)/);
  const plannedIssue = issueBefore ?? Number.NaN;
  let shortlist: { text?: string; exhausted: boolean } =
    planBefore || argsIssueMatch
      ? { exhausted: false }
      : await candidateShortlist(coordinationCwd, { leaseAuthority });
  let claimedLease: IssueLease | undefined;
  let claimedCandidate = false;
  for (let attempt = 0; attempt < 3 && !claimedCandidate; attempt += 1) {
    const candidate = Number.isSafeInteger(plannedIssue)
      ? String(plannedIssue)
      : argsIssueMatch
        ? argsIssueMatch[1]
        : shortlist.text?.match(/(?:^|\n)- #(\d+) /)?.[1];
    if (!candidate) break;
    try {
      const acquiredAt = new Date();
      claimedLease = await claimIssueLease(leaseAuthority, {
        issueNumber: Number(candidate),
        agent: "pi-next",
        runId: `cmd-${process.pid}-${acquiredAt.getTime()}`,
        sessionId: `session-${acquiredAt.getTime()}`,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(
          acquiredAt.getTime() + ISSUE_LEASE_DURATION_MS,
        ).toISOString(),
      });
      claimedCandidate = true;
    } catch (error) {
      if (!(error instanceof LeaseConflictError)) throw error;
      // Only the free-selection path (no plan, no explicit issue number) may
      // refresh the shortlist and retry; a plan or explicit issue number
      // means the caller wants that exact issue, so a conflict is terminal.
      if (planBefore || argsIssueMatch) throw error;
      shortlist = await candidateShortlist(coordinationCwd, { leaseAuthority });
    }
  }
  if (!claimedCandidate || !claimedLease) return undefined;
  try {
    const executionCwd = await ensureIssueWorktree(
      coordinationCwd,
      claimedLease.issueNumber,
      recordLifecycleEvent,
    );
    await quarantineInheritedArtifacts(
      coordinationCwd,
      executionCwd,
      claimedLease.issueNumber,
    );
    validateIssueWorkspaceBeforeWorker(executionCwd, claimedLease.issueNumber);
    return { leaseAuthority, claimedLease, executionCwd };
  } catch (error) {
    try {
      await releaseIssueLease(leaseAuthority, claimedLease, {
        cwd: coordinationCwd,
        recordEvent: recordLifecycleEvent,
      });
    } catch (releaseError) {
      const handoffMessage = error instanceof Error ? error.message : String(error);
      const releaseMessage = releaseError instanceof Error
        ? releaseError.message
        : String(releaseError);
      throw new Error(
        `Worktree handoff failed: ${handoffMessage}. Lease release also failed: ${releaseMessage}`,
        { cause: releaseError },
      );
    }
    throw error;
  }
}

/**
 * Claim the target issue, attach its canonical worktree, and run the
 * pi-next prompt in a fresh session pinned to that worktree cwd. Refuses to
 * send the prompt against the coordination checkout when handoff fails, per
 * #575's "no prompt-only convention" requirement.
 */
export async function runIssueScopedPrompt(
  ctx: ExtensionCommandContext,
  args: string,
  authorityOverride?: IssueLeaseAuthority,
  workerOverride?: IssueWorkerRunner,
  onWorkLog?: WorkerWorkLogSink,
): Promise<void> {
  const coordinationCwd = ctx.cwd;
  const display = attachWorkerDisplay(ctx);
  let workspace: ClaimedIssueWorkspace | undefined;
  try {
    workspace = await claimAndAttachIssueWorkspace(
      coordinationCwd,
      args,
      authorityOverride,
    );
  } catch (error) {
    notifySafely(
      ctx,
      `Issue claim/worktree handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (!workspace) {
    notifySafely(
      ctx,
      "No issue claim acquired; refusing to start implementation.",
      "warning",
    );
    return;
  }
  const { leaseAuthority, claimedLease, executionCwd } = workspace;
  const heartbeat = startIssueLeaseHeartbeat(leaseAuthority, claimedLease, {
    onError: (error) =>
      notifySafely(
        ctx,
        `Issue #${claimedLease.issueNumber} lease renewal stopped: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      ),
  });
  if (executionCwd !== coordinationCwd) trackCrashLoggerCwd(executionCwd);
  try {
    // ctx.newSession() cannot relocate a session's cwd: a new session
    // always inherits the cwd of whichever session/runtime is currently
    // active (traced through pi's own dist — AgentSessionRuntime.newSession
    // forwards `this.cwd`, which is never re-read from process.cwd()), so
    // `next.cwd` is always the coordination root here, never executionCwd.
    // The pi-coding-agent SDK gives extensions no other way to bind this
    // new session's tool execution (bash in particular) to executionCwd, so
    // The child worker owns its process cwd, so concurrent issue workers
    // never observe or clobber each other's worktree. An
    // assertion on next.cwd was therefore always false whenever executionCwd
    // differed from the coordination root — and since any exception thrown
    // inside withSession() is fatal to the *entire* pi process (interactive
    // mode routes it straight to handleFatalRuntimeError -> exit(1), not
    // just this command), that assertion silently killed the whole CLI on
    // every worktree-scoped run. The worker receives executionCwd explicitly.
    if (authorityOverride && !workerOverride) {
      await ctx.newSession({
        withSession: async (next) => {
          await next.sendUserMessage(buildPiNextPrompt(executionCwd, args));
        },
      });
    } else {
      await executeIssueWorker(
        executionCwd,
        buildPiNextPrompt(executionCwd, args),
        workerOverride,
        (elapsedMs) =>
          notifySafely(
            ctx,
            `Issue worker for #${claimedLease.issueNumber} still running (${Math.round(elapsedMs / 1_000)}s)`,
            "info",
          ),
        {
          issueNumber: claimedLease.issueNumber,
          runId: claimedLease.runId,
          phase: existsSync(planFile(executionCwd)) ? "implementation" : "planning",
          display,
          onActivity: (event: WorkerWorkLogEvent) => {
            if (currentGeneration()?.isDisposed()) return;
            const next = {
              ...event,
              issueNumber: event.issueNumber ?? claimedLease.issueNumber,
            };
            display?.event(next);
            if (onWorkLog) onWorkLog(next);
            else {
              notifySafely(
                ctx,
                `pi-next #${next.issueNumber ?? "?"} · ${next.phase} · ${next.kind} · ${next.summary}`,
                "info",
              );
            }
          },
        },
      );
    }
  } finally {
    await heartbeat.stop();
    try {
      await releaseIssueLease(leaseAuthority, heartbeat.getLease(), {
        cwd: coordinationCwd,
        recordEvent: recordLifecycleEvent,
      });
    } catch (error) {
      if (!(error instanceof LeaseConflictError)) {
        notifySafely(
          ctx,
          `Issue lease release failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    if (
      !existsSync(planFile(executionCwd))
    ) {
      try {
        await removeCompletedWorkflowArtifacts(
          executionCwd,
          claimedLease.issueNumber,
        );
        await removeCompletedCoordinationArtifacts(
          coordinationCwd,
          claimedLease.issueNumber,
        );
        await cleanupCompletedIssueWorktree(
          coordinationCwd,
          executionCwd,
          claimedLease.issueNumber,
        );
      } catch (error) {
        notifySafely(
          ctx,
          `Issue #${claimedLease.issueNumber} workspace retained after completion cleanup could not be proven: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    display?.dispose();
    trackCrashLoggerCwd(coordinationCwd);
  }
}

export function validateIssueWorkspaceBeforeWorker(
  workspaceCwd: string,
  issueNumber: number,
): void {
  const artifacts = workflowArtifacts(workspaceCwd);
  const foreign = artifacts.filter(
    (artifact) => artifact.issueNumber !== issueNumber,
  );
  if (foreign.length) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace contains workflow artifacts owned by another issue or with no valid identity`,
      foreign.map((artifact) => artifact.path),
    );
  }
  const rootPlan = `${workspaceCwd}/PLAN.md`;
  if (existsSync(rootPlan)) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace contains an unsupported root PLAN.md artifact`,
      [rootPlan],
    );
  }
  const plan = resolvePlanIdentity(workspaceCwd);
  if (plan.kind === "unresolved" || plan.kind === "ambiguous") {
    throw new PlanAuthorityError(plan.kind, plan.reason, plan.paths);
  }
  if (plan.kind === "resolved" && plan.issueNumber !== issueNumber) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace PLAN belongs to issue #${plan.issueNumber}`,
      [plan.path],
    );
  }
}

export function registerPiNextCommands(
  pi: ExtensionAPI,
  authorityOverride?: IssueLeaseAuthority,
  workerOverride?: IssueWorkerRunner,
) {
  pi.registerCommand("pi-next", {
    description: "Run the GitHub-backed pi-next workflow",
    getArgumentCompletions: (prefix) => {
      const values = ["auto", "fresh", "plan"].filter((value) =>
        value.startsWith(prefix),
      );
      return values.length
        ? values.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        if (trimmed === "auto") {
          // Auto is the continuous entry point. Reuse the bounded loop
          // controller so plan creation is followed by task execution,
          // verification/archive, and fresh live issue selection instead of
          // stopping after one isolated worker transition.
          await runPiNextLoop(String(MAX_ISSUES), ctx, (event) =>
            appendWorkerWorkLog(pi, event),
          );
          return;
        }
        if (trimmed === "fresh" || trimmed.startsWith("fresh ")) {
          await ctx.waitForIdle();
          const nextArgs = trimmed.replace(/^fresh\s*/, "");
          await runIssueScopedPrompt(
            ctx,
            nextArgs,
            authorityOverride,
            workerOverride,
            (event) => appendWorkerWorkLog(pi, event),
          );
          return;
        }
        // A follow-up prompt would mutate whichever session currently owns
        // the coordination cwd before this command had claimed an issue. Wait
        // for that session to finish, then perform the same claim -> worktree
        // handoff as every other implementation entry point.
        await ctx.waitForIdle();
        await runIssueScopedPrompt(
          ctx,
          args,
          authorityOverride,
          workerOverride,
          (event) => appendWorkerWorkLog(pi, event),
        );
      } catch (error) {
        // Command handlers run inside the extension host. Never let an
        // authority, worktree, or session error become an unhandled rejection
        // that takes the pi-next extension down with it.
        notifySafely(
          ctx,
          `pi-next failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("pi-next-fresh", {
    description: "Start pi-next in a parentless Pi session",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        // Keep the legacy alias on the same issue-scoped boundary. A fresh
        // session is still capable of creating PLAN/source state, so it must
        // never bypass claim and canonical-worktree preparation.
        await runIssueScopedPrompt(
          ctx,
          args,
          authorityOverride,
          workerOverride,
          (event) => appendWorkerWorkLog(pi, event),
        );
      } catch (error) {
        notifySafely(
          ctx,
          `pi-next fresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  registerPiNextLoopCommand(pi, (event) => appendWorkerWorkLog(pi, event));

  pi.registerCommand("pi-next-status", {
    description: "Show local plan state without invoking the model",
    handler: async (_args, ctx) => {
      try {
        const { stdout } = await runHelper(ctx.cwd, "pi-next-state.sh", [
          ctx.cwd,
        ]);
        const state = parseState(stdout);
        notifySafely(
          ctx,
          `PLAN=${state.PLAN} TASKS=${state.UNCHECKED_TASKS ?? state.UNCHECKED} ACCEPTANCE=${state.UNCHECKED_ACCEPTANCE ?? "-"} GOAL=${state.PLAN_GOAL || "-"}`,
          "info",
        );
        // A checked-off PLAN task or a "running"-looking durable loop-state
        // record is never evidence that a worker is actually alive right
        // now (#612) — only the live child runtime callback is. Surface both
        // explicitly rather than conflating them into one status line.
        const supervisor = currentSupervisorStatus(ctx.cwd);
        if (supervisor) {
          notifySafely(ctx, formatSupervisorStatus(supervisor), "info");
        }
      } catch (error) {
        notifySafely(
          ctx,
          `pi-next status failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("pi-next-handoff", {
    description: "Check whether Claude/Pi handoff is safe",
    handler: async (_args, ctx) => {
      try {
        const dirtyFiles = await changeFiles(ctx.cwd, "all");
        const marked = existsSync(markerFile(ctx.cwd));
        const safe = dirtyFiles.length === 0 && !marked;
        notifySafely(
          ctx,
          `Safe handoff: ${safe ? "yes" : "no"}\nDirty=${dirtyFiles.length ? "yes" : "no"} Continue=${marked ? "yes" : "no"}`,
          safe ? "info" : "warning",
        );
      } catch (error) {
        notifySafely(
          ctx,
          `pi-next handoff check failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { createWorkAuthority, type AuthorityWorkItem } from "../../src/coordination/work-authority.ts";
import { isIssueLeaseFresh } from "./issue-authority.ts";
import { findingPublicationEligible, type SelfAssessmentFinding } from "../../src/coordination/self-assessment.ts";
import { sanitizeFeedbackText } from "../../src/coordination/feedback.ts";
import { readHealthState, readSelfAssessmentFindings } from "./self-assessment.ts";
import { trackCrashLoggerCwd } from "./crash-log.ts";
import { sessionIdentity } from "./live-ctx.ts";
import { reportRuntimeFailure, reportWorkerToolFailures } from "./feedback-runtime.ts";
import { LocalIssueLeaseAuthority } from "./local-lease.ts";
import {
  CandidateDiscoveryError,
  candidateShortlist,
  classifyAuthorityEligibility,
  type CandidateShortlist,
} from "./issue-candidates.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { listLoopStates } from "./loop-state.ts";
import {
  currentGeneration,
  currentSupervisorStatus,
  formatSupervisorStatus,
} from "./supervisor-status.ts";
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
  formatMonitorStatus,
  getMonitor,
  startMonitor,
  stopMonitor,
} from "./monitor.ts";
import {
  quarantineInheritedArtifacts,
  quarantineLegacyRootArtifacts,
  registerPiNextLoopCommand,
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
  PlanAuthorityError,
  planFile,
  resolvePlanIdentity,
  safeNotify,
} from "./util.ts";
import {
  runIssueWorker,
  type IssueWorkerOptions,
  type IssueWorkerRunner,
} from "./util-core.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";
import { appendWorkerNarrative, appendWorkerWorkLog, type WorkerWorkLogSink } from "./work-log.ts";
import { attachWorkerDisplay } from "./worker-display.ts";
import { piNextRuntimeIdentity } from "../../src/version.ts";
import { createWorkerDispatch } from "../../src/coordination/worker-dispatch.ts";
import { readLastIncidentBundle, reportIncidentBundle } from "../../src/coordination/incident-reporting.ts";
import { createWorkerFailureEvidence, WorkerFailureError } from "./worker-failure.ts";
import {
  formatWorkflowState,
  preflightWorkflowStateProvider,
  selectedWorkflowStateProvider,
  WorkflowStateProviderError,
  workflowState,
} from "./workflow-state-provider.ts";
import { runProductionSingleIssueLifecycle } from "./production-lifecycle.ts";

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

function boundedStatusText(value: unknown, max = 240): string {
  return sanitizeFeedbackText(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
}

function assessmentStatusText(cwd: string): string {
  const config = loadPiNextConfig(cwd);
  const policy = config.assessment;
  const lines = [
    `Self-assessment: ${policy.enabled ? "enabled" : "disabled"}`,
    `Thresholds: no-progress=${policy.noProgressThreshold} repeated-failure=${policy.repeatedFailureThreshold} repeated-command=${policy.repeatedCommandThreshold} context-pressure=${policy.contextPressureThreshold} finding-recurrence=${policy.findingRecurrenceThreshold} minimum-confidence=${policy.findingMinConfidence}`,
    `Governance: labels=${policy.findingLabels.join(", ") || "none"} held=${policy.heldStates.join(", ") || "none"} approved=${policy.approvedStates.join(", ") || "none"} rejected=${policy.rejectedStates.join(", ") || "none"} superseded=${policy.supersededStates.join(", ") || "none"}`,
  ];
  if (!policy.enabled) {
    lines.push("Health: disabled (no evaluation or publication occurs)");
    return lines.join("\n");
  }
  const health = readHealthState(cwd);
  const signals: string[] = [];
  if (health) {
    if (health.noProgressStreak >= policy.noProgressThreshold) signals.push(`no-progress=${health.noProgressStreak}`);
    if (Object.values(health.failureCounts || {}).some((count) => count >= policy.repeatedFailureThreshold)) signals.push("repeated-failure");
    if (Object.values(health.commandCounts || {}).some((count) => count >= policy.repeatedCommandThreshold)) signals.push("repeated-command");
    if ((health.dimensions?.contextPressure || 0) >= policy.contextPressureThreshold) signals.push(`context-pressure=${Math.round((health.dimensions.contextPressure || 0) * 100)}%`);
  }
  lines.push(`Health: ${signals.length ? "escalate" : "healthy"} · signals=${signals.join(", ") || "none"} · transitions=${health?.transitionCount || 0} · last=${health?.updatedAt || "none"} · run=${health?.runId || "none"} · issue=${health?.issueNumber ? `#${health.issueNumber}` : "none"}`);
  const findings = readSelfAssessmentFindings(cwd)
    .sort((a, b) => b.updatedAt?.localeCompare(a.updatedAt || "") || b.fingerprint.localeCompare(a.fingerprint))
    .slice(0, 20);
  const eligible = findings.filter((finding) => findingPublicationEligible(finding, { recurrenceThreshold: policy.findingRecurrenceThreshold, minConfidence: policy.findingMinConfidence }));
  lines.push(`Findings: ${findings.length} total · ${eligible.length} eligible · ${findings.filter((finding) => finding.authorityId).length} published`);
  for (const finding of findings) lines.push(formatAssessmentFinding(finding, policy));
  if (!findings.length) lines.push("Findings: none (no deterministic anomalies retained)");
  return lines.join("\n");
}

function formatAssessmentFinding(
  finding: SelfAssessmentFinding,
  policy: ReturnType<typeof loadPiNextConfig>["assessment"],
): string {
  const eligible = findingPublicationEligible(finding, { recurrenceThreshold: policy.findingRecurrenceThreshold, minConfidence: policy.findingMinConfidence });
  const eligibility = eligible ? "eligible" : `not-eligible (recurrence/confidence threshold)`;
  const publication = finding.publication?.status || (finding.authorityId ? "published" : "not-attempted");
  const authority = finding.authorityId ? ` authority=${boundedStatusText(finding.authorityId, 80)}${finding.authorityUrl ? ` url=${boundedStatusText(finding.authorityUrl, 160)}` : ""}` : "";
  const diagnostic = finding.publication?.reason ? ` reason=${boundedStatusText(finding.publication.reason)}` : "";
  const evidence = finding.evidence.slice(0, 3).map((item) => boundedStatusText(item, 100)).join(" | ") || "none";
  return `Finding ${boundedStatusText(finding.fingerprint, 80)} · ${finding.category}/${finding.severity}/${finding.confidence} · recurrence=${finding.recurrence} · approval=${finding.approvalState} · ${eligibility} · publication=${publication}${authority}${diagnostic} · evidence=${evidence} · action=${boundedStatusText(finding.proposedAction, 120)}`;
}

async function issueQueueStatusText(cwd: string, sessionId: string | undefined, args: string): Promise<string> {
  const config = loadPiNextConfig(cwd);
  const filter = args.trim().toLowerCase() || "summary";
  const authority = createWorkAuthority(cwd, config);
  const items = await authority.listCandidates(config);
  const leases = new GitHubIssueLeaseAuthority(cwd);
  const active = listLoopStates(cwd).filter((state) => state.sessionId === sessionId && state.activeIssueNumber);
  const current = active.find((state) => state.status === "running")?.activeIssueNumber;
  let shortlist: CandidateShortlist;
  try {
    shortlist = await candidateShortlist(cwd, {
      authority,
      config,
      leaseAuthority: leases,
      completedIssues: active.flatMap((state) => state.completedIssues),
      deferredIssues: active.flatMap((state) => state.deferredIssues.map((issue) => issue.issueNumber)),
      refreshMain: false,
    });
  } catch (error) {
    return `Issue queue unavailable: ${boundedStatusText(error instanceof Error ? error.message : String(error))}`;
  }
  const rows: string[] = [];
  let unknown = false;
  const ordered = [...items].sort((left, right) => {
    const lp = config.selection.priorities.indexOf(left.priority || "");
    const rp = config.selection.priorities.indexOf(right.priority || "");
    return (lp < 0 ? 999 : lp) - (rp < 0 ? 999 : rp) || (left.number || 0) - (right.number || 0);
  });
  for (const item of ordered.slice(0, filter === "all" ? 100 : 30)) {
    if (!item.number) continue;
    let lease;
    try { lease = await leases.read(item.number); } catch { unknown = true; }
    const eligibility = classifyAuthorityEligibility(item, config);
    const currentDisposition = current === item.number
      ? eligibility.eligible
        ? "current/owned-by-this-run"
        : `current/yielded-${eligibility.disposition}: ${boundedStatusText(eligibility.reason, 100)}`
      : undefined;
    const disposition = currentDisposition
      || (lease && isIssueLeaseFresh(lease) ? `leased-other/${boundedStatusText(lease.agent, 40)}` : undefined)
      || (unknown ? "ownership-unknown" : undefined)
      || (!eligibility.eligible
        ? `${eligibility.disposition === "not_ready" ? "not-ready" : eligibility.disposition}/excluded`
        : undefined)
      || (active.some((state) => state.deferredIssues.some((issue) => issue.issueNumber === item.number)) ? "deferred-this-run" : "eligible");
    const filterMatch = filter === "active"
      ? disposition.startsWith("current/") || disposition.startsWith("leased-other")
      : disposition.startsWith(filter);
    if (filter !== "all" && filter !== "summary" && !filterMatch) continue;
    const shortlistMark = shortlist.candidateIssueNumber === item.number ? " shortlist=next" : "";
    const metric = active.find((state) => state.activeIssueNumber === item.number)?.issueMetrics.find((entry) => entry.issueNumber === item.number);
    const budget = metric
      ? ` transitions=${metric.transitions || 0} workers=${metric.workerLaunches || 0} tasks=${metric.planTasksRemaining ?? 0}/${metric.planTasksAtSelection ?? 0}`
      : "";
    rows.push(`#${item.number} ${item.priority || "-"} ${disposition}${budget}${shortlistMark} ${boundedStatusText(item.title, 160)}`);
  }
  const counts = {
    eligible: rows.filter((row) => row.includes(" eligible")).length,
    leased: rows.filter((row) => row.includes("leased-other")).length,
    blocked: rows.filter((row) => row.includes("blocked") || row.includes("not-ready") || row.includes("deferred") || row.includes("held-finding")).length,
    deferred: rows.filter((row) => row.includes("deferred")).length,
  };
  const lines = [
    `Current: ${current ? `#${current}` : "none"}`,
    `Eligible now: ${counts.eligible} · Leased by others: ${counts.leased} · Deferred this run: ${counts.deferred} · Blocked/not ready: ${counts.blocked}`,
    `Shortlist: ${shortlist.candidateIssueNumber ? `#${shortlist.candidateIssueNumber}` : "none"} · authority=${authority.name} · result=${shortlist.outcome}`,
    unknown ? "Ownership: unknown (lease authority unavailable; eligibility is fail-closed)" : "Ownership: lease authority read successfully",
    ...(rows.length ? rows : [shortlist.reason ? `No eligible issues: ${boundedStatusText(shortlist.reason)}` : "No issues in the bounded authority result"]),
  ];
  return lines.join("\n");
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
  observer?: Pick<IssueWorkerOptions, "issueNumber" | "runId" | "phase" | "dispatch" | "onActivity" | "onWorkerState" | "display">,
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
  await reportWorkerToolFailures(cwd, result.telemetry.toolFailures, result.telemetry.recoveredToolFailureFingerprints);
  if (!result.ok) {
    const evidence = result.failure ?? createWorkerFailureEvidence(
      { output: result.output, code: result.code, signal: result.signal },
      {
        issueNumber: observer?.issueNumber,
        runId: observer?.runId,
        phase: observer?.phase,
        dispatch: observer?.dispatch,
      },
    );
    const feedback = await reportRuntimeFailure(cwd, {
      stage: observer?.phase || "worker",
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
}

/**
 * Claim an issue lease and resolve/attach its canonical worktree, mirroring
 * the auto/explicit claim -> ensureIssueWorktree sequence so plain and
 * "fresh" pi-next invocations never mutate the shared coordination checkout.
 * Candidate resolution uses an explicit issue number when supplied, otherwise
 * the live shortlist; the coordination checkout's workflow files are never
 * treated as issue ownership.
 */
async function claimAndAttachIssueWorkspace(
  coordinationCwd: string,
  args: string,
  authorityOverride?: IssueLeaseAuthority,
): Promise<ClaimedIssueWorkspace | undefined> {
  // Production always uses the shared GitHub-backed authority; tests may
  // inject an in-memory authority to exercise this exact handoff sequence
  // without a live GitHub dependency.
  const leaseAuthority = authorityOverride ?? (
    loadPiNextConfig(coordinationCwd).authority.adapter === "memory"
      ? new LocalIssueLeaseAuthority(coordinationCwd)
      : new GitHubIssueLeaseAuthority(coordinationCwd)
  );
  // The coordination checkout is not an issue-plan namespace. Explicit issue
  // selection uses the requested number; otherwise consult live authority,
  // never a historical PLAN/VERIFY left in the root checkout.
  const argsIssueMatch = args.trim().match(/#?(\d+)/);
  let shortlist: CandidateShortlist = argsIssueMatch
    ? { exhausted: false, outcome: "candidate" }
    : await candidateShortlist(coordinationCwd, { leaseAuthority });
  if (shortlist.outcome === "unavailable") {
    throw new CandidateDiscoveryError(shortlist.reason || "authority query failed");
  }
  let claimedLease: IssueLease | undefined;
  let claimedCandidate = false;
  for (let attempt = 0; attempt < 3 && !claimedCandidate; attempt += 1) {
    const candidate = argsIssueMatch
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
      if (argsIssueMatch) throw error;
      shortlist = await candidateShortlist(coordinationCwd, { leaseAuthority });
      if (shortlist.outcome === "unavailable") {
        throw new CandidateDiscoveryError(shortlist.reason || "authority query failed");
      }
    }
  }
  if (!claimedCandidate || !claimedLease) return undefined;
  try {
    const executionCwd = await ensureIssueWorktree(
      coordinationCwd,
      claimedLease.issueNumber,
      recordLifecycleEvent,
      { ownership: { lease: claimedLease, authority: leaseAuthority } },
    );
    await quarantineInheritedArtifacts(
      coordinationCwd,
      executionCwd,
      claimedLease.issueNumber,
      claimedLease.runId,
    );
    await quarantineLegacyRootArtifacts(coordinationCwd, claimedLease.runId);
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
    await preflightWorkflowStateProvider(coordinationCwd);
  } catch (error) {
    notifySafely(
      ctx,
      `Workflow state provider preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
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
    const result = await runProductionSingleIssueLifecycle({
      cwd: coordinationCwd,
      issueNumber: claimedLease.issueNumber,
      entry: "explicit",
      runId: claimedLease.runId,
      allowRepair: true,
      review: false,
      finalize: true,
    }, {
      worker: workerOverride,
      onWorkLog: (event) => {
        const next = { ...event, issueNumber: event.issueNumber ?? claimedLease.issueNumber };
        display?.event(next);
        if (onWorkLog) onWorkLog(next);
      },
    });
    notifySafely(ctx, `pi-next #${claimedLease.issueNumber} ${result.disposition}`, result.disposition === "pass" || result.disposition === "already-satisfied" ? "info" : "warning");
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
      const values = ["auto", "fresh", "plan", "report --last", "report --last --github", "monitor start", "monitor stop", "monitor status"].filter((value) =>
        value.startsWith(prefix),
      );
      return values.length
        ? values.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        if (trimmed === "monitor start") {
          const status = startMonitor(ctx, (next) => {
            ctx.ui.setStatus("pi-next-monitor", formatMonitorStatus(next).replace(/\n/g, " · "));
          });
          notifySafely(ctx, formatMonitorStatus(status), "info");
          return;
        }
        if (trimmed === "monitor stop") {
          const status = stopMonitor(ctx);
          ctx.ui.setStatus("pi-next-monitor", undefined);
          notifySafely(ctx, status ? formatMonitorStatus(status) : "Monitor: stopped", "info");
          return;
        }
        if (trimmed === "monitor" || trimmed === "monitor status") {
          notifySafely(ctx, formatMonitorStatus(getMonitor(ctx.cwd, sessionIdentity(ctx))?.snapshot()), "info");
          return;
        }
        if (trimmed === "report" || trimmed === "report --last" || trimmed === "report --last --github" || /^report\s+--issue\s+\d+(?:\s+--github)?$/.test(trimmed)) {
          const issueMatch = trimmed.match(/--issue\s+(\d+)/);
          const bundle = readLastIncidentBundle(ctx.cwd, issueMatch ? Number.parseInt(issueMatch[1]!, 10) : undefined);
          if (!bundle) {
            notifySafely(ctx, "No local pi-next incident bundle is available", "warning");
            return;
          }
          const result = await reportIncidentBundle(ctx.cwd, bundle, { github: /(?:^|\s)--github(?:\s|$)/.test(trimmed) });
          const github = result.github ? `\nGitHub: ${result.github.status}${"url" in result.github && result.github.url ? ` ${result.github.url}` : ""}${"reason" in result.github ? ` (${result.github.reason})` : ""}` : "";
          notifySafely(ctx, `Incident: ${bundle.fingerprint}\nClassification: ${bundle.classification.category}/${bundle.classification.reportability}\nLocal: ${result.local.path}${github}`, "info");
          return;
        }
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

  // Auto-loop keeps mechanical worker activity in the secondary live widget;
  // only assistant summaries, verification results, and errors enter the
  // normal transcript.
  registerPiNextLoopCommand(pi, (event) => appendWorkerNarrative(pi, event));

  pi.registerCommand("pi-next-doctor", {
    description: "Check the installed pi-next package, project config, and workflow prerequisites",
    handler: async (_args, ctx) => {
      try {
        const identity = piNextRuntimeIdentity();
        const config = loadPiNextConfig(ctx.cwd);
        const state = await workflowState(ctx.cwd);
        const provider = selectedWorkflowStateProvider(config);
        notifySafely(
          ctx,
          [
            `Pi-next version=${identity.version} revision=${identity.revision}`,
            `Config: valid (adapter=${config.authority.adapter}, schema=${config.version})`,
            `Workflow state provider: ${provider} (validated)`,
            formatWorkflowState(state.state),
            `Project policy: ${config.repositoryPolicy.entrypoints.join(", ") || "none configured"}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        void reportRuntimeFailure(ctx.cwd, {
          stage: "doctor",
          category: error instanceof WorkflowStateProviderError ? "repository" : "runtime",
          severity: "error",
          outcome: "failed",
          code: error instanceof WorkflowStateProviderError ? "workflow_state_provider_failed" : "doctor_failed",
          summary: error instanceof Error ? error.message : String(error),
          error,
        });
        notifySafely(
          ctx,
          `pi-next doctor failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("pi-next-report", {
    description: "Show or publish the last bounded pi-next incident report without invoking the model",
    handler: async (args, ctx) => {
      try {
        const issueMatch = args.match(/--issue\s+(\d+)/);
        const bundle = readLastIncidentBundle(ctx.cwd, issueMatch ? Number.parseInt(issueMatch[1]!, 10) : undefined);
        if (!bundle) {
          notifySafely(ctx, "No local pi-next incident bundle is available", "warning");
          return;
        }
        const result = await reportIncidentBundle(ctx.cwd, bundle, { github: /(?:^|\s)--github(?:\s|$)/.test(args) });
        const github = result.github ? `\nGitHub: ${result.github.status}${"url" in result.github && result.github.url ? ` ${result.github.url}` : ""}${"reason" in result.github ? ` (${result.github.reason})` : ""}` : "";
        notifySafely(ctx, `Incident: ${bundle.fingerprint}\nClassification: ${bundle.classification.category}/${bundle.classification.reportability}\nLocal: ${result.local.path}${github}`, "info");
      } catch (error) {
        notifySafely(ctx, `pi-next report failed: ${boundedStatusText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });

  pi.registerCommand("pi-next-issues", {
    description: "Show the bounded authoritative issue queue without mutating leases or work items",
    handler: async (args, ctx) => {
      try {
        notifySafely(ctx, await issueQueueStatusText(ctx.cwd, sessionIdentity(ctx), args), "info");
      } catch (error) {
        notifySafely(ctx, `pi-next issues failed: ${boundedStatusText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });

  pi.registerCommand("pi-next-assessment", {
    description: "Show bounded self-assessment health, findings, and publication status without invoking the model",
    handler: async (_args, ctx) => {
      try {
        notifySafely(ctx, assessmentStatusText(ctx.cwd), "info");
      } catch (error) {
        notifySafely(ctx, `pi-next assessment status failed: ${boundedStatusText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });

  pi.registerCommand("pi-next-status", {
    description: "Show local plan state without invoking the model",
    handler: async (_args, ctx) => {
      try {
        const result = await workflowState(ctx.cwd);
        const state = result.state;
        notifySafely(
          ctx,
          `Provider=${result.provider} PLAN=${state.PLAN} TASKS=${state.UNCHECKED_TASKS ?? state.UNCHECKED ?? "-"} ACCEPTANCE=${state.UNCHECKED_ACCEPTANCE ?? "-"} GOAL=${state.PLAN_GOAL || "-"}`,
          "info",
        );
        // A checked-off PLAN task or a "running"-looking durable loop-state
        // record is never evidence that a worker is actually alive right
        // now (#612) — only the live child runtime callback is. Surface both
        // explicitly rather than conflating them into one status line.
        const supervisor = currentSupervisorStatus(ctx.cwd, undefined, sessionIdentity(ctx));
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

import type { SupervisorStatus } from "./foreground-supervisor.ts";
import type { LoopState } from "./loop-state.ts";
import type { WorkerWorkLogPhase } from "./worker-activity.ts";

export interface AutoProgressRenderOptions {
  supervisor?: Pick<SupervisorStatus, "workerAlive" | "workerLiveness" | "elapsedMs" | "workerPhase"> | null;
  /** Installed package version shown in the controller-owned footer. */
  version?: string;
  /** Maximum line width. The status API is one line, so never return a wrapped line. */
  width?: number;
}

/** Issues settled for this run; scheduler-yielded issues remain outstanding. */
export function settledIssueCount(state: Pick<LoopState, "completedIssues" | "deferredIssues">): number {
  const settled = new Set<number>(state.completedIssues);
  for (const issue of state.deferredIssues) {
    if (issue.kind !== "yielded") settled.add(issue.issueNumber);
  }
  return settled.size;
}

export function settledIssuePercent(
  requestedIssues: number,
  settled: number,
): number {
  if (!Number.isFinite(requestedIssues) || requestedIssues <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((settled / requestedIssues) * 100)));
}

function phaseLabel(
  state: LoopState,
  supervisor?: AutoProgressRenderOptions["supervisor"],
): string {
  if (state.recovery?.lastOutcome === "reconciling") return "reconciling";
  if (state.recovery?.lastOutcome === "recovery_unsafe" || state.recovery?.lastOutcome === "recovery_exhausted") {
    return "recovery blocked";
  }

  switch (state.status) {
    case "completed": return "complete";
    case "idle": return "idle";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "stopped": return "stopped";
    case "interrupted": return "interrupted";
    default: break;
  }

  const workerPhase = supervisor?.workerPhase;
  if (workerPhase) {
    const labels: Record<WorkerWorkLogPhase, string> = {
      planning: "planning",
      implementation: "implementing",
      verification: "verifying",
      repair: "repairing",
      recovery: "recovering",
      unknown: "working",
    };
    return labels[workerPhase];
  }
  if (supervisor?.workerAlive) return "working";
  if (state.recovery?.lastOutcome === "resuming_same_issue") return "recovering";
  if (state.lastOutcome === "yield_issue") return "yielded";
  return state.activeIssueNumber ? "claiming" : "selecting";
}

function progressBar(percent: number, slots: number): string {
  const filled = Math.round((percent / 100) * slots);
  return "[" + "█".repeat(filled) + "░".repeat(Math.max(0, slots - filled)) + "]";
}

function duration(ms: number | null | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function boundedWidth(width: number | undefined): number {
  return Math.max(20, Math.floor(width || 80));
}

/** Keep terminal reasons useful without copying the full diagnostic transcript. */
function terminalReason(state: LoopState): string | undefined {
  if (state.status === "completed") return undefined;
  if (state.status === "idle") {
    return /no eligible|exhaust/i.test(state.lastReason || "")
      ? "no eligible candidates"
      : undefined;
  }
  const raw = state.lastReason?.replace(/\s+/g, " ").trim();
  if (!raw) {
    if (state.status === "interrupted" || state.status === "stopped") return "resume available";
    return undefined;
  }
  if (/foreign|malformed|authority|workflow artifact/i.test(raw)) return "workspace authority conflict";
  if (/lease|ownership/i.test(raw)) return "ownership conflict";
  if (/exhaust|retry/i.test(raw) || state.recovery?.lastOutcome === "recovery_exhausted") return "retry exhausted";
  if (/unsafe|ambiguous|corrupt/i.test(raw) || state.recovery?.lastOutcome === "recovery_unsafe") return "manual recovery required";
  if (/interrupt|abandon|missing|stop/i.test(raw)) return "resume available";
  return raw.length <= 36 ? raw : `${raw.slice(0, 33)}...`;
}

/**
 * Render the compact, truthful auto-loop footer. `maxSteps` is deliberately
 * not accepted here: it is a safety budget, never queue completion progress.
 */
export function renderAutoProgress(
  state: LoopState,
  options: AutoProgressRenderOptions = {},
): string {
  const requested = Math.max(0, Math.trunc(state.requestedIssues));
  const settled = Math.min(requested, settledIssueCount(state));
  const percent = settledIssuePercent(requested, settled);
  const completed = new Set(state.completedIssues).size;
  const deferred = new Set(state.deferredIssues.map((issue) => issue.issueNumber)).size;
  const remaining = Math.max(0, requested - settled);
  const issue = state.activeIssueNumber ? `#${state.activeIssueNumber}` : undefined;
  const phase = phaseLabel(state, options.supervisor);
  const reason = terminalReason(state);
  const elapsed = duration(options.supervisor?.elapsedMs);
  const recoveryOutcome = state.recovery?.lastOutcome;
  const recovery = recoveryOutcome && recoveryOutcome !== "settled_from_durable_evidence"
    ? `recovery:${recoveryOutcome.replaceAll("_", " ")}`
    : "recovery:none";
  const retryAttempt = state.recovery?.lastFingerprint
    ? state.recovery.attemptsByFingerprint[state.recovery.lastFingerprint] || 0
    : 0;
  const retry = retryAttempt > 0
    ? `retry ${retryAttempt}/${state.recovery?.retryLimit || 3}`
    : undefined;
  const session = `session ${state.sessionTransition || 0}/${state.sessionTransitionLimit || 3}`;
  const step = `step ${state.step}/${state.maxSteps}`;
  const width = boundedWidth(options.width);
  const version = options.version ? `v${options.version} ` : "";

  // Keep the issue and phase ahead of optional detail when the terminal is
  // narrow. This is still a single status line and cannot wrap the transcript.
  const compact = issue
    ? `${issue} · ${phase} · ${settled}/${requested} ${percent}%`
    : `Pi-next auto · ${phase} · ${settled}/${requested} ${percent}%`;
  if (width < 48) return compact.slice(0, width);

  const barSlots = width < 128 ? 8 : 18;
  const primary = `Pi-next ${version}auto ${progressBar(percent, barSlots)} ${settled}/${requested} settled ${percent}%`;
  const current = (issue ? ` · ${issue} · ${phase}` : ` · ${phase}`) + (reason ? ` · ${reason}` : "");
  const counts = state.status === "idle"
    ? ` · ✓${completed} ↷${deferred} · ${remaining} capacity remaining`
    : ` · ✓${completed} ↷${deferred} · ${remaining} remaining`;
  const diagnostics = [recovery, retry, session, step, elapsed]
    .filter(Boolean).join(" · ");
  const full = primary + current + counts + (diagnostics ? ` · ${diagnostics}` : "");
  if (full.length <= width) return full;

  // At ordinary terminal widths keep controller diagnostics by shortening the
  // prose around the progress bar before dropping recovery/session/step data.
  const concisePrefix = version ? `Pi-next ${version.trim()}` : "Pi-next auto";
  const concisePrimary = `${concisePrefix} ${progressBar(percent, barSlots)} ${settled}/${requested} settled ${percent}%`;
  const concise = concisePrimary + current + ` · ${remaining} rem` + (diagnostics ? ` · ${diagnostics}` : "");
  if (concise.length <= width) return concise;

  const medium = primary + current + counts;
  if (medium.length <= width) return medium;
  if (reason) {
    // Terminal reasons are the recovery handoff, so preserve them ahead of
    // the decorative bar/diagnostics when the full line does not fit.
    const terminal = `${concisePrefix} · ${issue || "auto"} · ${phase} · ${settled}/${requested} settled · ${reason}`;
    if (terminal.length <= width) return terminal;
  }
  const short = primary + current;
  if (short.length <= width) return short;
  return short.slice(0, width);
}

export function autoLifecyclePhase(
  state: LoopState,
  supervisor?: AutoProgressRenderOptions["supervisor"],
): string {
  return phaseLabel(state, supervisor);
}
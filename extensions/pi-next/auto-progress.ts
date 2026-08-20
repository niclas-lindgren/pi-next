import type { SupervisorStatus } from "./foreground-supervisor.ts";
import type { LoopState } from "./loop-state.ts";
import type { WorkerWorkLogPhase } from "./worker-activity.ts";

export interface AutoProgressRenderOptions {
  supervisor?: Pick<SupervisorStatus, "workerAlive" | "workerLiveness" | "elapsedMs" | "workerPhase"> | null;
  /** Maximum line width. The status API is one line, so never return a wrapped line. */
  width?: number;
}

/** Issues settled for this run, including deferred and blocked issues. */
export function settledIssueCount(state: Pick<LoopState, "completedIssues" | "deferredIssues">): number {
  const settled = new Set<number>(state.completedIssues);
  for (const issue of state.deferredIssues) settled.add(issue.issueNumber);
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
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function boundedWidth(width: number | undefined): number {
  return Math.max(20, Math.floor(width || 100));
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
  const elapsed = duration(options.supervisor?.elapsedMs);
  const recovery = state.recovery?.lastOutcome &&
    !["settled_from_durable_evidence"].includes(state.recovery.lastOutcome)
    ? "recovery"
    : undefined;
  const width = boundedWidth(options.width);

  // Keep the issue and phase ahead of optional detail when the terminal is
  // narrow. This is still a single status line and cannot wrap the transcript.
  const compact = issue
    ? `${issue} · ${phase} · ${settled}/${requested} ${percent}%`
    : `Pi-next auto · ${phase} · ${settled}/${requested} ${percent}%`;
  if (width < 48) return compact.slice(0, width);

  const barSlots = width < 72 ? 8 : width < 96 ? 12 : 18;
  const primary = `Pi-next auto ${progressBar(percent, barSlots)} ${settled}/${requested} settled ${percent}%`;
  const current = issue ? ` · ${issue} · ${phase}` : ` · ${phase}`;
  const counts = ` · ✓${completed} ↷${deferred} · ${remaining} remaining`;
  const diagnostics = [
    state.step > 0 ? `step ${state.step}` : undefined,
    recovery,
    elapsed,
  ].filter(Boolean).join(" · ");
  const full = primary + current + counts + (diagnostics ? ` · ${diagnostics}` : "");
  if (full.length <= width) return full;

  const medium = primary + current + counts;
  if (medium.length <= width) return medium;
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
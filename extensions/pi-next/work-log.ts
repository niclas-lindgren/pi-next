import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { reportSwallowedHostDeliveryFailure } from "./crash-log.ts";
import type { WorkerWorkLogEvent, WorkerWorkLogKind } from "./worker-activity.ts";

/** The subset of Pi's real `Theme` this renderer actually calls. */
interface RenderTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

export type WorkerWorkLogSink = (event: WorkerWorkLogEvent) => void;

export const WORK_LOG_ENTRY_TYPE = "pi-next-worker-log";

export type WorkerLogView =
  | { mode: "all" }
  | { mode: "off" }
  | { mode: "issue"; issueNumber: number }
  | { mode: "run"; runId: string };

let workerLogView: WorkerLogView = { mode: "all" };

/** Current transcript/live-display filter, shared by work-log.ts and worker-display.ts (#614). */
export function getWorkerLogView(): WorkerLogView {
  return workerLogView;
}

/**
 * Live-panel presentation density (#617), orthogonal to `WorkerLogView`'s
 * issue/run selection: `verbose` is the richer default (visible text plus a
 * bounded recent-activity window); `compact` is the original small
 * known-good baseline, kept as an explicit fallback/compatibility mode.
 * Purely presentational — `worker-display.ts` reads this to decide how much
 * of a worker's state to render, never whether it runs.
 */
export type WorkerLogVerbosity = "compact" | "verbose";

let workerLogVerbosity: WorkerLogVerbosity = "verbose";

export function getWorkerLogVerbosity(): WorkerLogVerbosity {
  return workerLogVerbosity;
}

/** Test-only reset so unrelated specs never observe a leaked module state. */
export function __resetWorkerLogPresentationForTests(): void {
  workerLogView = { mode: "all" };
  workerLogVerbosity = "verbose";
}

export function workerLogViewMatches(
  event: WorkerWorkLogEvent,
  view: WorkerLogView = workerLogView,
): boolean {
  if (view.mode === "all") return true;
  if (view.mode === "off") return false;
  if (view.mode === "issue") return event.issueNumber === view.issueNumber;
  const runId = event.runId || "";
  return (
    runId === view.runId ||
    runId.startsWith(view.runId) ||
    runId.endsWith(view.runId)
  );
}

function describeView(view: WorkerLogView): string {
  if (view.mode === "all") return "all worker sessions";
  if (view.mode === "off") return "hidden";
  if (view.mode === "issue") return `issue #${view.issueNumber}`;
  return `run ${view.runId}`;
}

function parseView(args: string): WorkerLogView | undefined {
  const value = args.trim();
  if (!value || value.toLowerCase() === "all") return { mode: "all" };
  if (["off", "none", "hide"].includes(value.toLowerCase())) {
    return { mode: "off" };
  }
  const issue = value.match(/^(?:issue\s+|#)?(\d+)$/i);
  if (issue) {
    const issueNumber = Number.parseInt(issue[1], 10);
    return Number.isSafeInteger(issueNumber) && issueNumber > 0
      ? { mode: "issue", issueNumber }
      : undefined;
  }
  const run = value.match(/^run\s+(.+)$/i);
  if (run?.[1]?.trim()) return { mode: "run", runId: run[1].trim() };
  return undefined;
}

function kindLabel(kind: WorkerWorkLogKind): string {
  if (kind === "assistant") return "AGENT";
  if (kind === "verify") return "TEST";
  return kind.toUpperCase();
}

function kindColor(kind: WorkerWorkLogKind): string {
  if (kind === "assistant") return "accent";
  if (kind === "read" || kind === "search") return "dim";
  if (kind === "edit") return "warning";
  if (kind === "verify") return "toolTitle";
  if (kind === "error") return "error";
  return "muted";
}

function renderEvent(data: WorkerWorkLogEvent, theme: RenderTheme): string {
  const issue = data.issueNumber ? `#${data.issueNumber}` : "#?";
  const run = data.runId ? ` · r:${data.runId.slice(-8)}` : "";
  const phase = data.phase !== "unknown" ? ` · ${data.phase}` : "";
  const identity = `${theme.bold(theme.fg("accent", issue))}${theme.fg("dim", run + phase)}`;
  const label = theme.bold(theme.fg(kindColor(data.kind), kindLabel(data.kind)));

  if (data.kind === "assistant") {
    const paths = data.relatedPaths?.length
      ? `\n${theme.fg("dim", `↳ ${data.relatedPaths.join(", ")}`)}`
      : "";
    return `${identity} ${label}\n${theme.fg("text", data.summary)}${paths}`;
  }

  const summaryColor =
    data.kind === "error"
      ? "error"
      : data.kind === "read" || data.kind === "search"
        ? "dim"
        : "text";
  const paths = data.relatedPaths?.length
    ? ` ${theme.fg("dim", `· ${data.relatedPaths.join(", ")}`)}`
    : "";
  return `${identity} ${label} ${theme.fg(summaryColor, data.summary)}${paths}`;
}

/**
 * Render child Pi sessions as one multiplexed transcript. Every event carries
 * deterministic issue/run identity, so concurrent child sessions can be
 * interleaved safely. `/pi-next-view` changes only presentation; it never
 * affects worker lifecycle, lease ownership, or execution.
 */
export function registerWorkerWorkLogRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<WorkerWorkLogEvent>(
    WORK_LOG_ENTRY_TYPE,
    (entry: { data?: WorkerWorkLogEvent }, _options: unknown, theme: RenderTheme) => {
      const data = entry.data;
      if (!data || !workerLogViewMatches(data)) return new Text("", 0, 0);
      return new Text(renderEvent(data, theme), 0, 0);
    },
  );

  pi.registerCommand("pi-next-view", {
    description:
      "Filter/style the multiplexed pi-next worker transcript: all | off | #N | issue N | run <id> | compact | verbose | status",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "status") {
        ctx.ui.notify(
          `pi-next transcript view: ${describeView(workerLogView)} · ${workerLogVerbosity}`,
          "info",
        );
        return;
      }
      if (value === "compact" || value === "verbose") {
        workerLogVerbosity = value;
        ctx.ui.notify(`pi-next live panel: ${value}`, "info");
        return;
      }
      const requested = parseView(args);
      if (!requested) {
        ctx.ui.notify(
          "Usage: /pi-next-view all | off | #610 | issue 610 | run <run-id> | compact | verbose | status",
          "warning",
        );
        return;
      }
      workerLogView = requested;
      ctx.ui.notify(`pi-next transcript view: ${describeView(workerLogView)}`, "info");
    },
  });
}

/** Append one already-normalized event; failures cannot affect the worker. */
export function appendWorkerWorkLog(
  pi: ExtensionAPI,
  event: WorkerWorkLogEvent,
): void {
  try {
    // Always retain attributed events for direct worker commands. Auto-loop
    // uses appendWorkerNarrative below so mechanical activity stays in the
    // live secondary widget instead of dominating the normal transcript.
    pi.appendEntry(WORK_LOG_ENTRY_TYPE, event);
  } catch (error) {
    // A replaced/shutting-down TUI is not an execution failure, but a
    // genuinely broken appendEntry() call was previously indistinguishable
    // from "nothing to report yet" — record it (diagnostic-only).
    reportSwallowedHostDeliveryFailure(error, "appendWorkerWorkLog");
  }
}

/**
 * Keep auto-loop transcript entries semantic: assistant-visible summaries,
 * verification outcomes, and failures. Reads, searches, edits, and tool
 * starts remain available in the owner-bound live activity widget.
 */
export function appendWorkerNarrative(
  pi: ExtensionAPI,
  event: WorkerWorkLogEvent,
): void {
  if (!["assistant", "verify", "error"].includes(event.kind)) return;
  appendWorkerWorkLog(pi, event);
}

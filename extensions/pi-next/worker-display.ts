import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { reportSwallowedHostDeliveryFailure } from "./crash-log.ts";
import { getWorkerLogVerbosity, getWorkerLogView, workerLogViewMatches } from "./work-log.ts";
import type {
  WorkerLiveTextDelta,
  WorkerWorkLogEvent,
  WorkerWorkLogPhase,
} from "./worker-activity.ts";

/** The subset of Pi's real `Theme` this controller actually calls. */
interface RenderTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

type WorkerRunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted";

interface DisplayItem {
  kind: "tool" | "verify" | "error" | "text";
  text: string;
}

interface WorkerDisplayState {
  issueNumber?: number;
  runId?: string;
  phase: WorkerWorkLogPhase;
  status: WorkerRunStatus;
  currentText: string;
  recentItems: DisplayItem[];
  startedAt: number;
  lastActivityAt: number;
}

const LIVE_TEXT_LIMIT = 240;
/**
 * Bounded recent-activity window (#617). `COMPACT_ITEMS_LIMIT` preserves the
 * original small known-good baseline; `VERBOSE_ITEMS_LIMIT` sits inside the
 * issue's suggested "~8-15 meaningful items per worker" range.
 */
const COMPACT_ITEMS_LIMIT = 3;
const VERBOSE_ITEMS_LIMIT = 12;
/** Richer visible-text region for verbose mode (#617); still bounded. */
const VERBOSE_LIVE_TEXT_LIMIT = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const SETTLED_RETENTION_MS = 4_000;
const WIDGET_KEY = "pi-next-workers";
const DIAGNOSTIC_COUNTER_LIMIT = 1_000_000;
const DIAGNOSTIC_EVENT_TYPE_LIMIT = 16;
const DIAGNOSTIC_EVENT_TYPE_LENGTH = 80;

export interface WorkerDisplayDiagnostics {
  displayAttached: number;
  stdoutBytes: number;
  ndjsonRecords: number;
  visibleTextDeltas: number;
  toolStarts: number;
  widgetRenderAttempts: number;
  widgetRenderFailures: number;
  eventTypes: string[];
}

export interface WorkerDisplaySink {
  event(logEvent: WorkerWorkLogEvent): void;
  liveDelta(delta: WorkerLiveTextDelta): void;
  recordStdoutBytes(bytes: number): void;
  recordNdjsonRecord(raw: unknown): void;
  recordToolStart(): void;
  finish(
    issueNumber: number | undefined,
    runId: string | undefined,
    status: "completed" | "failed" | "aborted",
  ): void;
}

function keyOf(issueNumber: number | undefined, runId: string | undefined): string {
  return `${issueNumber ?? "?"} ${runId ?? "?"}`;
}

function argsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function statusLabel(state: WorkerDisplayState): string {
  switch (state.status) {
    case "starting":
      return "starting";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return state.phase !== "unknown" ? state.phase : "working";
  }
}

/** Bounded, deterministic elapsed-time label (e.g. "34s", "1m40s"), never negative. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function itemColor(item: DisplayItem): string {
  if (item.kind === "error") return "error";
  if (item.kind === "verify") return "toolTitle";
  if (item.kind === "text") return "text";
  return "muted";
}

/**
 * In-memory live-display state for concurrently running pi-next child
 * workers (#614), kept separate from durable transcript history
 * (work-log.ts's `appendWorkerWorkLog`). State here is mutated directly
 * from the child's own JSON event stream — including per-token visible
 * text deltas — so a worker's activity appears in the parent TUI while it
 * is still generating, instead of only once a full message/tool call has
 * completed. `/pi-next-view` (work-log.ts) filters this the same way it
 * filters durable transcript entries; filtering is presentation-only and
 * never affects execution, leases, or worker ownership.
 */
export class WorkerDisplayController implements WorkerDisplaySink {
  private readonly workers = new Map<string, WorkerDisplayState>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private settledTimers = new Set<ReturnType<typeof setTimeout>>();
  private renderScheduled = false;
  private disposed = false;
  private hostContext: ExtensionCommandContext | undefined;
  private readonly diagnosticState: WorkerDisplayDiagnostics = {
    displayAttached: 0,
    stdoutBytes: 0,
    ndjsonRecords: 0,
    visibleTextDeltas: 0,
    toolStarts: 0,
    widgetRenderAttempts: 0,
    widgetRenderFailures: 0,
    eventTypes: [],
  };

  constructor(private readonly theme: RenderTheme) {}

  /** Bind this sink to its owning command/session context. */
  attachContext(ctx: ExtensionCommandContext): void {
    if (!this.disposed && ctx.hasUI) {
      this.hostContext = ctx;
      this.increment("displayAttached");
      // Exercise the smallest valid widget immediately. Subsequent worker
      // events replace this heartbeat with attributed live content.
      this.scheduleRender();
    }
  }

  recordStdoutBytes(bytes: number): void {
    if (this.disposed || !Number.isFinite(bytes) || bytes < 0) return;
    this.increment("stdoutBytes", Math.floor(bytes));
  }

  recordNdjsonRecord(raw: unknown): void {
    if (this.disposed) return;
    this.increment("ndjsonRecords");
    const type = argsOf(raw)?.type;
    if (typeof type === "string" && this.diagnosticState.eventTypes.length < DIAGNOSTIC_EVENT_TYPE_LIMIT) {
      const bounded = type.slice(0, DIAGNOSTIC_EVENT_TYPE_LENGTH);
      if (!this.diagnosticState.eventTypes.includes(bounded)) {
        this.diagnosticState.eventTypes.push(bounded);
      }
    }
  }

  recordToolStart(): void {
    if (!this.disposed) this.increment("toolStarts");
  }

  liveDelta(delta: WorkerLiveTextDelta): void {
    if (this.disposed) return;
    this.increment("visibleTextDeltas");
    const state = this.ensure(delta.issueNumber, delta.runId);
    state.status = "running";
    // Always retain the larger (verbose) buffer; compact rendering trims its
    // own smaller view at render time so a live verbosity toggle never loses
    // already-buffered text (#617).
    state.currentText = `${state.currentText}${delta.delta}`.slice(-VERBOSE_LIVE_TEXT_LIMIT);
    state.lastActivityAt = Date.now();
    this.scheduleRender();
  }

  event(logEvent: WorkerWorkLogEvent): void {
    if (this.disposed) return;
    const state = this.ensure(logEvent.issueNumber, logEvent.runId);
    state.phase = logEvent.phase;
    state.lastActivityAt = Date.now();
    state.status = "running";
    if (logEvent.kind === "assistant") {
      // The full message just landed durably; the live preview buffer is
      // superseded by it, not appended to.
      state.currentText = "";
      this.push(state, {
        kind: "text",
        text: logEvent.summary.split("\n")[0] || logEvent.summary,
      });
    } else if (logEvent.kind === "error") {
      state.status = "failed";
      this.push(state, { kind: "error", text: logEvent.summary });
    } else if (logEvent.kind === "verify") {
      this.push(state, { kind: "verify", text: logEvent.summary });
    } else {
      this.push(state, { kind: "tool", text: logEvent.summary });
    }
    this.scheduleRender();
  }

  finish(
    issueNumber: number | undefined,
    runId: string | undefined,
    status: "completed" | "failed" | "aborted",
  ): void {
    if (this.disposed) return;
    const key = keyOf(issueNumber, runId);
    const state = this.workers.get(key);
    if (!state) return;
    state.status = status;
    state.currentText = "";
    state.lastActivityAt = Date.now();
    this.scheduleRender();
    // Keep the settled summary visible briefly instead of vanishing
    // instantly, then drop it so the widget never accumulates dead runs.
    const timer = setTimeout(() => {
      this.settledTimers.delete(timer);
      if (!this.disposed && this.workers.get(key) === state) {
        this.workers.delete(key);
        this.scheduleRender();
      }
    }, SETTLED_RETENTION_MS);
    this.settledTimers.add(timer);
    timer.unref?.();
  }

  private ensure(
    issueNumber: number | undefined,
    runId: string | undefined,
  ): WorkerDisplayState {
    const key = keyOf(issueNumber, runId);
    let state = this.workers.get(key);
    if (!state) {
      state = {
        issueNumber,
        runId,
        phase: "unknown",
        status: "starting",
        currentText: "",
        recentItems: [],
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      this.workers.set(key, state);
      this.ensureHeartbeat();
    }
    return state;
  }

  private push(state: WorkerDisplayState, item: DisplayItem): void {
    state.recentItems.push(item);
    // Always retain the larger (verbose) window for the same live-toggle
    // reason as liveDelta() above; compact rendering shows only its own
    // smaller tail slice (#617).
    if (state.recentItems.length > VERBOSE_ITEMS_LIMIT) state.recentItems.shift();
  }

  private increment(
    key: Exclude<keyof WorkerDisplayDiagnostics, "eventTypes">,
    amount = 1,
  ): void {
    this.diagnosticState[key] = Math.min(
      DIAGNOSTIC_COUNTER_LIMIT,
      this.diagnosticState[key] + amount,
    );
  }

  /** Return bounded, payload-free diagnostics for real-host troubleshooting. */
  diagnostics(): WorkerDisplayDiagnostics {
    return { ...this.diagnosticState, eventTypes: [...this.diagnosticState.eventTypes] };
  }

  /** Bounded fallback liveness so a genuinely quiet worker still visibly ticks. */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.scheduleRender(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private scheduleRender(): void {
    if (this.disposed || this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (!this.disposed) this.flush();
    });
  }

  private flush(): void {
    if (this.workers.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.disposed || !this.hostContext) return;
    const ctx = this.hostContext;
    try {
      const lines = this.workers.size ? this.renderLines() : ["worker alive"];
      this.increment("widgetRenderAttempts");
      ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined, {
        placement: "aboveEditor",
      });
    } catch (error) {
      this.increment("widgetRenderFailures");
      reportSwallowedHostDeliveryFailure(error, "workerDisplayWidget");
    }
  }

  private visibleWorkers(): WorkerDisplayState[] {
    const view = getWorkerLogView();
    return [...this.workers.values()].filter((state) =>
      workerLogViewMatches(
        {
          issueNumber: state.issueNumber,
          runId: state.runId,
          phase: state.phase,
          kind: "assistant",
          summary: "",
        },
        view,
      ),
    );
  }

  private idleSuffix(state: WorkerDisplayState): string {
    const idleMs = Date.now() - state.lastActivityAt;
    // A bounded liveness tick for a genuinely quiet worker (#614): once no
    // new event has landed for a full heartbeat interval, show elapsed idle
    // time so a stalled-looking display is distinguishable from one that
    // simply has nothing new to say.
    return state.status === "running" && idleMs >= HEARTBEAT_INTERVAL_MS
      ? ` (idle ${Math.round(idleMs / 1_000)}s)`
      : "";
  }

  private footer(visibleCount: number): string {
    return this.theme.fg(
      "dim",
      `${visibleCount} worker${visibleCount === 1 ? "" : "s"} active`,
    );
  }

  renderLines(): string[] {
    return getWorkerLogVerbosity() === "compact"
      ? this.renderCompactLines()
      : this.renderVerboseLines();
  }

  /** Original small known-good baseline (#614), kept as an explicit fallback/compatibility mode (#617). */
  private renderCompactLines(): string[] {
    const visible = this.visibleWorkers();
    if (visible.length === 0) return [];
    const lines: string[] = [];
    for (const state of visible) {
      const issue = state.issueNumber ? `#${state.issueNumber}` : "#?";
      lines.push(
        this.theme.bold(this.theme.fg("accent", issue)) +
          this.theme.fg("dim", ` · ${statusLabel(state)}${this.idleSuffix(state)}`),
      );
      if (state.currentText) {
        lines.push(`  ${this.theme.fg("text", state.currentText.slice(-LIVE_TEXT_LIMIT))}`);
      }
      for (const item of state.recentItems.slice(-COMPACT_ITEMS_LIMIT)) {
        lines.push(
          `  ${this.theme.fg("muted", item.kind === "text" ? "" : "→ ")}${this.theme.fg(
            itemColor(item),
            item.text,
          )}`,
        );
      }
    }
    lines.push(this.footer(visible.length));
    return lines;
  }

  /**
   * Richer default view (#617): a larger bounded region per worker showing
   * elapsed runtime, the current visible assistant text, and more recent
   * meaningful activity, so a glance answers "which issues are active, what
   * phase, what did it just say, what is it touching, is it alive."
   */
  private renderVerboseLines(): string[] {
    const visible = this.visibleWorkers();
    if (visible.length === 0) return [];
    const lines: string[] = [];
    for (const state of visible) {
      const issue = state.issueNumber ? `#${state.issueNumber}` : "#?";
      const elapsed = formatElapsed(Date.now() - state.startedAt);
      lines.push(
        this.theme.bold(this.theme.fg("accent", issue)) +
          this.theme.fg(
            "dim",
            ` · ${statusLabel(state)} · active ${elapsed}${this.idleSuffix(state)}`,
          ),
      );
      if (state.currentText) {
        for (const line of state.currentText.split("\n")) {
          lines.push(`  ${this.theme.fg("text", line)}`);
        }
      }
      const items = state.recentItems.slice(-VERBOSE_ITEMS_LIMIT);
      for (const item of items) {
        lines.push(
          `  ${this.theme.fg("muted", item.kind === "text" ? "" : "→ ")}${this.theme.fg(
            itemColor(item),
            item.text,
          )}`,
        );
      }
      if (state.status === "running") {
        const idleMs = Date.now() - state.lastActivityAt;
        lines.push(
          this.theme.fg("dim", `  last event ${Math.max(0, Math.round(idleMs / 1_000))}s ago`),
        );
      }
    }
    lines.push(this.footer(visible.length));
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const timer of this.settledTimers) clearTimeout(timer);
    this.settledTimers.clear();
    this.workers.clear();
    const ctx = this.hostContext;
    this.hostContext = undefined;
    if (!ctx) return;
    try {
      this.increment("widgetRenderAttempts");
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch (error) {
      this.increment("widgetRenderFailures");
      reportSwallowedHostDeliveryFailure(error, "workerDisplayDispose");
    }
  }
}

/** Create an owner-bound display sink; no process-global callback router. */
export function attachWorkerDisplay(
  ctx: ExtensionCommandContext,
  existing?: WorkerDisplayController,
): WorkerDisplayController | undefined {
  if (!ctx.hasUI) return existing;
  const display = existing ?? new WorkerDisplayController(
    ctx.ui.theme as unknown as RenderTheme,
  );
  display.attachContext(ctx);
  return display;
}

/** Test-only reset so unrelated specs never observe a leaked singleton. */
export function __resetWorkerDisplayForTests(): void {}

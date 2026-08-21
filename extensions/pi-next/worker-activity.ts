import {
  feedbackFingerprint,
  sanitizeFeedbackText,
  type FeedbackCategory,
  type FeedbackSeverity,
} from "../../src/coordination/feedback.ts";

export type WorkerWorkLogPhase =
  | "planning"
  | "implementation"
  | "verification"
  | "repair"
  | "recovery"
  | "unknown";

export type WorkerWorkLogKind =
  | "assistant"
  | "read"
  | "search"
  | "edit"
  | "verify"
  | "tool"
  | "error";

export type WorkerToolFailureClass =
  | "expected_current_work"
  | "repository_tooling"
  | "environment"
  | "runtime"
  | "timeout"
  | "ownership_integrity"
  | "unknown";

/** One safe, bounded observation shared by display, feedback, and health. */
export interface WorkerToolFailureObservation {
  issueNumber?: number;
  runId?: string;
  phase: WorkerWorkLogPhase;
  tool: string;
  commandClass?: string;
  failureClass: WorkerToolFailureClass;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  durationMs?: number;
  summary: string;
  diagnosticExcerpt?: string;
  relatedPaths?: string[];
  fingerprint: string;
}

export interface WorkerWorkLogEvent {
  issueNumber?: number;
  runId?: string;
  phase: WorkerWorkLogPhase;
  kind: WorkerWorkLogKind;
  summary: string;
  relatedPaths?: string[];
  failureObservation?: WorkerToolFailureObservation;
}

export interface WorkerActivityContext {
  issueNumber?: number;
  runId?: string;
  phase?: string;
}

/** Ephemeral, payload-free observations of the structured child stream. */
export interface WorkerActivityObserver {
  onNdjsonRecord?: (raw: unknown) => void;
  onToolStart?: () => void;
}

const TOOL_SUMMARY_LIMIT = 300;
const ASSISTANT_TEXT_LIMIT = 4_000;
const PATH_LIMIT = 160;
const MAX_PATHS = 4;
const MAX_EVENTS_PER_WORKER = 300;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BLOCK_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SENSITIVE_VALUE = /(api[_ -]?key|access[_ -]?token|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi;
const FAILURE_EXCERPT_LIMIT = 240;
const FAILURE_SUMMARY_LIMIT = 300;
const FAILURE_PATH_LIMIT = 4;

const PHASES = new Set<WorkerWorkLogPhase>([
  "planning",
  "implementation",
  "verification",
  "repair",
  "recovery",
  "unknown",
]);

function redact(value: string): string {
  return sanitizeFeedbackText(value).replace(SENSITIVE_VALUE, "$1=[redacted]");
}

function cleanInline(value: string, limit: number): string {
  return redact(
    value
      .replace(INLINE_CONTROL_CHARACTERS, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, limit)
    .trim();
}

function cleanBlock(value: string, limit: number): string {
  return redact(
    value
      .replace(/\r\n?/g, "\n")
      .replace(BLOCK_CONTROL_CHARACTERS, " ")
      .replace(/\t/g, "  ")
      .split("\n")
      .map((line) => line.replace(/[ ]{2,}/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
    .slice(0, limit)
    .trim();
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = cleanInline(value, PATH_LIMIT);
  if (!path || path === ".env" || /(^|[\\/])\.env(?:\.|$)/.test(path)) {
    return path ? "[redacted path]" : undefined;
  }
  return path;
}

function phaseOf(value: unknown, fallback?: string): WorkerWorkLogPhase {
  const candidate = typeof value === "string" ? value : fallback;
  return candidate && PHASES.has(candidate as WorkerWorkLogPhase)
    ? (candidate as WorkerWorkLogPhase)
    : "unknown";
}

function metadata(context: WorkerActivityContext, phase?: unknown) {
  return {
    issueNumber: context.issueNumber,
    runId: context.runId,
    phase: phaseOf(phase, context.phase),
  };
}

function event(
  context: WorkerActivityContext,
  kind: WorkerWorkLogKind,
  summary: string,
  options: {
    phase?: unknown;
    relatedPaths?: unknown[];
    failureObservation?: WorkerToolFailureObservation;
    block?: boolean;
  } = {},
): WorkerWorkLogEvent | undefined {
  const boundedSummary = options.block
    ? cleanBlock(summary, ASSISTANT_TEXT_LIMIT)
    : cleanInline(summary, TOOL_SUMMARY_LIMIT);
  if (!boundedSummary) return undefined;
  const paths = (options.relatedPaths ?? [])
    .map(safePath)
    .filter((path): path is string => Boolean(path))
    .slice(0, MAX_PATHS);
  return {
    ...metadata(context, options.phase),
    kind,
    summary: boundedSummary,
    ...(paths.length ? { relatedPaths: paths } : {}),
    ...(options.failureObservation ? { failureObservation: options.failureObservation } : {}),
  };
}

function argsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolPath(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return [args.path, args.filePath, args.file_path, args.cwd]
    .map(safePath)
    .filter((path): path is string => Boolean(path));
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  for (const key of ["toolCallId", "tool_call_id", "callId", "id"]) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return undefined;
}

function numberField(value: unknown, keys: readonly string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.trunc(candidate);
  }
  return undefined;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key]) return source[key] as string;
  }
  return undefined;
}

/** Read only diagnostic-shaped result fields; tool args and arbitrary payloads are excluded. */
function diagnosticText(value: unknown, depth = 0): string {
  if (depth > 3 || value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => diagnosticText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const source = value as Record<string, unknown>;
  const chunks: string[] = [];
  for (const key of ["stderr", "error", "message", "reason", "summary", "output", "stdout", "text", "content"]) {
    if (source[key] !== undefined) {
      const chunk = diagnosticText(source[key], depth + 1);
      if (chunk) chunks.push(chunk);
    }
  }
  return chunks.join("\n");
}

function diagnosticExcerpt(value: unknown): string | undefined {
  const lines = cleanBlock(diagnosticText(value), 1_200)
    .split("\n")
    .map((line) => cleanInline(line, 240))
    .filter(Boolean);
  if (!lines.length) return undefined;
  const meaningful = lines.filter((line) => /error|fail|exception|fatal|cannot|unable|not found|missing|denied|invalid|timeout|timed out|killed|signal|exit/i.test(line));
  return (meaningful.length ? meaningful.slice(-3) : lines.slice(-3)).join(" · ").slice(0, FAILURE_EXCERPT_LIMIT);
}

function commandClass(tool: string, command: string | undefined, excerpt: string): string {
  const value = `${command || ""} ${excerpt}`.toLowerCase();
  if (/\bnpm\s+run\b|missing script|package script/.test(value)) return "package-script";
  if (/\b(tests?|verify|vitest|jest|playwright|pytest|specs?)\b/.test(value)) return "test";
  if (/\b(lint|eslint|format|prettier)\b/.test(value)) return "lint";
  if (/\b(build|compile|tsc|typecheck)\b/.test(value)) return "build";
  if (/\bgit\b/.test(value) || tool === "git") return "git";
  if (/\b(rg|grep|find|search)\b/.test(value)) return "search";
  if (tool === "bash") return "shell";
  return tool || "tool";
}

function classifyToolFailure(
  tool: string,
  command: string | undefined,
  excerpt: string,
  timedOut: boolean,
  signal: string | undefined,
): WorkerToolFailureClass {
  if (timedOut) return "timeout";
  const value = `${command || ""} ${excerpt}`;
  if (/ownership|worktree|lease|authority|integrity|invariant|pi[- ]next.*(?:error|fail|exception)/i.test(value) || signal === "SIGABRT") return "ownership_integrity";
  if (/(?:test|spec|assertion).*failed|\b\d+\s+(?:tests?|specs?)\s+failed|expect\(/i.test(value) || /^(?:pi_next_check|verify)/i.test(tool)) return "expected_current_work";
  if (/missing script|unknown command|cannot find module|module not found|no such file or directory|tsc: not found|npm ERR!/i.test(value)) return "repository_tooling";
  if (/command not found|enoent|eacces|network|connection|unavailable|rate limit|certificate|authentication/i.test(value)) return "environment";
  if (signal || /runtime|exception|stack trace/i.test(value)) return "runtime";
  return "unknown";
}

function feedbackCategory(failureClass: WorkerToolFailureClass): FeedbackCategory {
  if (failureClass === "expected_current_work") return "work";
  if (failureClass === "repository_tooling") return "repository";
  if (failureClass === "environment" || failureClass === "timeout") return "external";
  if (failureClass === "runtime") return "runtime";
  if (failureClass === "ownership_integrity") return "integrity";
  return "work";
}

export function workerToolFailureFeedbackCategory(failureClass: WorkerToolFailureClass): FeedbackCategory {
  return feedbackCategory(failureClass);
}

export function workerToolFailureFeedbackSeverity(failureClass: WorkerToolFailureClass): FeedbackSeverity {
  return failureClass === "runtime" || failureClass === "ownership_integrity" ? "error" : failureClass === "expected_current_work" ? "info" : "warning";
}

export interface WorkerToolStartContext {
  toolName: string;
  command?: string;
  relatedPaths?: string[];
}

export function createWorkerToolFailureObservation(
  raw: Record<string, unknown>,
  context: WorkerActivityContext,
  start: WorkerToolStartContext = { toolName: typeof raw.toolName === "string" ? raw.toolName : "tool" },
): WorkerToolFailureObservation {
  const tool = cleanInline(start.toolName || "tool", 80) || "tool";
  const result = raw.result;
  const details = result && typeof result === "object" ? (result as Record<string, unknown>).details : undefined;
  const excerpt = diagnosticExcerpt(result ?? raw);
  const command = start.command || (typeof raw.command === "string" ? raw.command : undefined);
  const timedOut = raw.timedOut === true || raw.timeout === true || details && typeof details === "object" && ((details as Record<string, unknown>).timedOut === true || (details as Record<string, unknown>).timeout === true) || /timed out|timeout/i.test(excerpt || "");
  const signal = stringField(raw, ["signal", "terminationSignal"]) || stringField(details, ["signal", "terminationSignal"]);
  const exitCode = numberField(raw, ["exitCode", "exit_code", "code"]) ?? numberField(details, ["exitCode", "exit_code", "code"]);
  const durationMs = numberField(raw, ["durationMs", "duration", "elapsedMs"]) ?? numberField(details, ["durationMs", "duration", "elapsedMs"]);
  const failureClass = classifyToolFailure(tool, command, excerpt || "", Boolean(timedOut), signal);
  const category = commandClass(tool, command, excerpt || "");
  const reason = excerpt || (timedOut ? "timed out" : signal ? signal : exitCode === undefined ? "tool execution failed" : `exit ${exitCode}`);
  const status = timedOut
    ? `${tool} timed out${durationMs !== undefined ? ` · ${Math.round(durationMs / 1_000)}s` : ""}`
    : `${tool} failed${exitCode !== undefined ? ` · exit ${exitCode}` : signal ? ` · ${signal}` : ""}`;
  const summary = `${status} · ${reason}`.slice(0, FAILURE_SUMMARY_LIMIT);
  const safeSummary = sanitizeFeedbackText(summary);
  const fingerprint = feedbackFingerprint({
    harness: "pi-next",
    stage: phaseOf(context.phase),
    category: feedbackCategory(failureClass),
    code: `tool_${failureClass}_${category}`,
    summary: safeSummary,
  });
  const paths = [...(start.relatedPaths || []), ...toolPath(argsOf(details))]
    .map(safePath)
    .filter((path): path is string => Boolean(path))
    .slice(0, FAILURE_PATH_LIMIT);
  return {
    ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
    ...(context.runId ? { runId: sanitizeFeedbackText(context.runId).slice(0, 80) } : {}),
    phase: phaseOf(context.phase),
    tool,
    commandClass: category,
    failureClass,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal ? { signal: sanitizeFeedbackText(signal).slice(0, 32) } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.min(86_400_000, durationMs)) }),
    summary: safeSummary,
    ...(excerpt ? { diagnosticExcerpt: sanitizeFeedbackText(excerpt).slice(0, FAILURE_EXCERPT_LIMIT) } : {}),
    ...(paths.length ? { relatedPaths: paths } : {}),
    fingerprint,
  };
}

const PI_NEXT_INSPECT_ACTION_LABELS: Record<string, string> = {
  state: "inspecting workflow state",
  current_task: "checking current task",
  validate: "validating plan",
  handoff: "checking handoff safety",
  drift: "checking plan drift",
};

const PI_NEXT_GIT_ACTION_LABELS: Record<string, string> = {
  status: "checking git status",
  commit: "committing changes",
  checkpoint_branch: "creating checkpoint branch",
  checkpoint: "checkpointing progress",
  promote: "promoting checkpoint",
};

/**
 * Deterministic, richer labels for pi-next's own custom tools (#617). Their
 * `tool_execution_start` args already carry a closed `action` enum (see
 * each tool's own `parameters` schema), so the label is derived from real
 * call metadata rather than model-authored narration.
 */
function pinextToolLabel(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const action = typeof args?.action === "string" ? args.action : undefined;
  if (!action) return undefined;
  if (toolName === "pi_next_inspect") return PI_NEXT_INSPECT_ACTION_LABELS[action];
  if (toolName === "pi_next_git") return PI_NEXT_GIT_ACTION_LABELS[action];
  return undefined;
}

function commandLabel(command: unknown): {
  kind: WorkerWorkLogKind;
  summary: string;
} {
  if (typeof command !== "string") {
    return { kind: "tool", summary: "running a command" };
  }
  const value = command.toLowerCase();
  if (/\b(vitest|npm\s+(run\s+)?(test|verify|lint|build)|tsc|eslint|playwright)\b/.test(value)) {
    return { kind: "verify", summary: "running tests or verification" };
  }
  if (/\b(rg|grep|find|git\s+(status|diff|log|show))\b/.test(value)) {
    return { kind: "search", summary: "inspecting repository state" };
  }
  return { kind: "tool", summary: "running a command" };
}

function visibleAssistantText(message: Record<string, unknown> | undefined): string {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => argsOf(part))
    .filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => String(part.text))
    .join("\n");
}

/**
 * Normalize one safe, user-visible event from Pi's JSON stream.
 *
 * The child process already emits the same structured session events Pi uses
 * for its own UI. The parent therefore acts as a thin presentation proxy:
 * ordinary assistant-visible text and safe tool activity are forwarded with
 * deterministic issue/run identity. Thinking blocks, prompts, raw tool
 * arguments/results and message deltas are never forwarded.
 */
export function normalizeWorkerStreamEvent(
  raw: unknown,
  context: WorkerActivityContext,
  startContext?: WorkerToolStartContext,
): WorkerWorkLogEvent | undefined {
  const value = argsOf(raw);
  if (!value || typeof value.type !== "string") return undefined;

  if (value.type === "message_end") {
    const summary = visibleAssistantText(argsOf(value.message));
    return event(context, "assistant", summary, { block: true });
  }

  if (value.type === "tool_execution_end") {
    const toolName = typeof value.toolName === "string" ? value.toolName : "tool";
    if (value.isError === true) {
      const observation = createWorkerToolFailureObservation(value, context, startContext || { toolName });
      return event(context, "error", observation.summary, {
        relatedPaths: observation.relatedPaths,
        failureObservation: observation,
      });
    }
    if (toolName === "pi_next_check") {
      return event(context, "verify", "structured verification completed");
    }
    return undefined;
  }

  if (value.type !== "tool_execution_start") return undefined;

  const toolName = typeof value.toolName === "string" ? value.toolName : "tool";
  const args = argsOf(value.args);
  const paths = toolPath(args);
  let kind: WorkerWorkLogKind = "tool";
  let summary = `using ${cleanInline(toolName, 80) || "a tool"}`;

  if (toolName === "read") {
    kind = "read";
    summary = paths[0] ? `reading ${paths[0]}` : "reading a file";
  } else if (["edit", "write"].includes(toolName)) {
    kind = "edit";
    summary = paths[0] ? `editing ${paths[0]}` : "editing a file";
  } else if (["grep", "find", "rg"].includes(toolName)) {
    kind = "search";
    summary = "searching the repository";
  } else if (toolName === "bash") {
    ({ kind, summary } = commandLabel(args?.command));
  } else if (toolName === "pi_next_check") {
    kind = "verify";
    summary = "running structured verification";
  } else {
    const richer = pinextToolLabel(toolName, args);
    if (richer) summary = richer;
  }

  return event(context, kind, summary, { relatedPaths: paths });
}

/** Parse one complete NDJSON line without exposing the original payload. */
export function parseWorkerActivityLine(
  line: string,
  context: WorkerActivityContext,
): WorkerWorkLogEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return undefined;
  try {
    return normalizeWorkerStreamEvent(JSON.parse(trimmed), context);
  } catch {
    return undefined;
  }
}

export interface WorkerLiveTextDelta {
  issueNumber?: number;
  runId?: string;
  delta: string;
}

const MAX_LIVE_DELTAS_PER_WORKER = 20_000;

/**
 * Extract one live, visible text chunk from Pi's raw streaming wire event
 * (#614). Only `message_update` events whose `assistantMessageEvent.type`
 * is exactly `"text_delta"` ever produce a value here — every other
 * `assistantMessageEvent` type (`thinking_delta`/`thinking_start`/
 * `thinking_end`/`toolcall_delta`/...) is unmatched and therefore silently
 * dropped by construction (an allowlist, not a blocklist), so hidden
 * reasoning can never reach the live display no matter how the wire format
 * evolves.
 */
export function extractLiveTextDelta(
  raw: unknown,
  context: WorkerActivityContext,
): WorkerLiveTextDelta | undefined {
  const value = argsOf(raw);
  if (!value || value.type !== "message_update") return undefined;
  const assistantMessageEvent = argsOf(value.assistantMessageEvent);
  if (!assistantMessageEvent || assistantMessageEvent.type !== "text_delta") {
    return undefined;
  }
  const delta =
    typeof assistantMessageEvent.delta === "string"
      ? cleanInline(assistantMessageEvent.delta, TOOL_SUMMARY_LIMIT)
      : "";
  if (!delta) return undefined;
  return { issueNumber: context.issueNumber, runId: context.runId, delta };
}

/** Incremental parser used while the child is still alive. */
export class IncrementalWorkerActivityParser {
  private pending = "";
  private lastKey = "";
  private eventCount = 0;
  private liveDeltaCount = 0;
  private readonly toolStarts = new Map<string, WorkerToolStartContext>();
  private lastToolStart?: WorkerToolStartContext;

  constructor(
    private readonly context: WorkerActivityContext,
    private readonly onEvent: (event: WorkerWorkLogEvent) => void,
    private readonly onLiveDelta?: (delta: WorkerLiveTextDelta) => void,
    private readonly observer?: WorkerActivityObserver,
  ) {}

  push(chunk: string | Buffer): void {
    this.pending += String(chunk);
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.parse(line);
  }

  finish(): void {
    if (this.pending) this.parse(this.pending);
    this.pending = "";
  }

  private parse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }

    try {
      this.observer?.onNdjsonRecord?.(raw);
      if (argsOf(raw)?.type === "tool_execution_start") {
        this.observer?.onToolStart?.();
      }
    } catch {
      // Diagnostics must never terminate or alter the worker.
    }

    if (this.onLiveDelta && this.liveDeltaCount < MAX_LIVE_DELTAS_PER_WORKER) {
      const delta = extractLiveTextDelta(raw, this.context);
      if (delta) {
        this.liveDeltaCount += 1;
        try {
          this.onLiveDelta(delta);
        } catch {
          // Presentation/observability must never terminate or alter the worker.
        }
      }
    }

    const value = argsOf(raw);
    let startContext: WorkerToolStartContext | undefined;
    if (value?.type === "tool_execution_start") {
      const toolName = typeof value.toolName === "string" ? value.toolName : "tool";
      const args = argsOf(value.args);
      startContext = {
        toolName,
        ...(typeof args?.command === "string" ? { command: args.command } : {}),
        relatedPaths: toolPath(args),
      };
      this.lastToolStart = startContext;
      const id = toolCallId(value);
      if (id) this.toolStarts.set(id, startContext);
    } else if (value?.type === "tool_execution_end") {
      const id = toolCallId(value);
      startContext = (id ? this.toolStarts.get(id) : undefined) || this.lastToolStart;
      if (id) this.toolStarts.delete(id);
    }

    const next = normalizeWorkerStreamEvent(raw, this.context, startContext);
    if (!next || this.eventCount >= MAX_EVENTS_PER_WORKER) return;
    const key = `${next.kind}\u0000${next.summary}\u0000${next.runId ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.eventCount += 1;
    try {
      this.onEvent(next);
    } catch {
      // Presentation/observability must never terminate or alter the worker.
    }
  }
}

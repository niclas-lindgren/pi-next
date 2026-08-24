import { BootstrapError } from "./errors.js";
import { BootstrapReporter, WorkerFactory, WorkerReport, WorkerRole, WorkerSession, WorkerStats } from "./types.js";
import { extractAssistantTextDelta, parseReviewResultText } from "./reviewer.js";
import { emitProgress, progressToolName, redact } from "./utils.js";
import { classifyWorkerCompletion, createWorkerTerminalEvidence, observeWorkerEvent } from "../coordination/worker-terminal-result.js";

function workerStats(session: WorkerSession): { toolCalls: number; usage?: WorkerStats; warning?: string } {
  const stats = session.getSessionStats?.();
  if (!stats) return { toolCalls: 0 };
  const tokens = stats.tokens ?? stats;
  const usage: WorkerStats = {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    total: tokens.total ?? 0,
    cost: stats.cost ?? 0,
  };
  const hasTokenStats = stats.tokens !== undefined;
  const warning = hasTokenStats && usage.cost > 0 && usage.total === 0
    ? "SDK reported nonzero cost with zero token usage"
    : undefined;
  return { toolCalls: stats.toolCalls ?? 0, usage, warning };
}

export async function runWorker(
  factory: WorkerFactory,
  role: WorkerRole,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  reports: WorkerReport[],
  issueNumber: number,
  reporter: BootstrapReporter | undefined,
  heartbeatMs: number,
  parentSignal?: AbortSignal,
): Promise<WorkerReport> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let session: WorkerSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let toolCalls = 0;
  let assistantText = "";
  let model: string | undefined;
  let lastSafeProgress = started;
  let cancelParent: (() => void) | undefined;
  let terminalEvidence = createWorkerTerminalEvidence();
  emitProgress(reporter, { issueNumber, phase: "worker", state: "start", role });
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastSafeProgress < heartbeatMs) return;
      emitProgress(reporter, { issueNumber, phase: "worker", state: "heartbeat", role, model, elapsedMs: now - started, toolCalls });
      lastSafeProgress = now;
    }, heartbeatMs);
  }
  try {
    session = await factory({ cwd, role, signal: controller.signal });
    model = session.model?.provider && session.model.id ? `${session.model.provider}/${session.model.id}` : undefined;
    emitProgress(reporter, { issueNumber, phase: "worker", state: "ready", role, model, elapsedMs: Date.now() - started, toolCalls });
    lastSafeProgress = Date.now();
    unsubscribe = session.subscribe((event) => {
      if (typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_execution_end") {
        toolCalls += 1;
        const tool = progressToolName(event);
        emitProgress(reporter, { issueNumber, phase: "worker", state: "activity", role, model, tool, elapsedMs: Date.now() - started, toolCalls });
        lastSafeProgress = Date.now();
      }
      const delta = extractAssistantTextDelta(event);
      if (delta) assistantText = `${assistantText}${delta}`.slice(-16_000);
      terminalEvidence = observeWorkerEvent(terminalEvidence, event);
    });
    const cancellation = new Promise<never>((_, reject) => {
      cancelParent = () => { controller.abort(); reject(new BootstrapError(`worker ${role} cancelled`)); };
      if (parentSignal?.aborted) cancelParent();
      else parentSignal?.addEventListener("abort", cancelParent, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BootstrapError(`worker ${role} timed out`)); }, timeoutMs);
    });
    await Promise.race([session.prompt(prompt), timeout, cancellation]);
    const stats = workerStats(session);
    const classification = classifyWorkerCompletion(terminalEvidence);
    const report: WorkerReport = classification.ok
      ? {
          role,
          disposition: "completed",
          model,
          durationMs: Date.now() - started,
          toolCalls: Math.max(toolCalls, stats.toolCalls),
          usage: stats.usage,
          telemetryWarning: stats.warning,
          reviewResult: role === "review" ? parseReviewResultText(assistantText) : undefined,
          stopReason: terminalEvidence.stopReason,
          terminalResultObserved: terminalEvidence.sawAssistantMessage,
        }
      : {
          role,
          disposition: "failed",
          model,
          durationMs: Date.now() - started,
          toolCalls: Math.max(toolCalls, stats.toolCalls),
          usage: stats.usage,
          telemetryWarning: stats.warning,
          reason: redact(`${classification.code}: ${classification.detail}`),
          stopReason: terminalEvidence.stopReason,
          terminalResultObserved: terminalEvidence.sawAssistantMessage,
        };
    reports.push(report);
    emitProgress(reporter, {
      issueNumber,
      phase: "worker",
      state: classification.ok ? "completed" : "fail",
      role,
      model,
      elapsedMs: report.durationMs,
      toolCalls: report.toolCalls,
      detail: classification.ok ? undefined : report.disposition,
    });
    return report;
  } catch (error) {
    const timedOut = error instanceof BootstrapError && error.message.includes("timed out");
    const cancelled = controller.signal.aborted && !timedOut;
    if (session?.abort) await session.abort().catch(() => undefined);
    const stats = session ? workerStats(session) : { toolCalls };
    const report: WorkerReport = {
      role,
      disposition: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
      model,
      durationMs: Date.now() - started,
      toolCalls: Math.max(toolCalls, stats.toolCalls),
      usage: stats.usage,
      telemetryWarning: stats.warning,
      reason: redact(error instanceof Error ? error.message : String(error)),
      stopReason: terminalEvidence.stopReason,
      terminalResultObserved: terminalEvidence.sawAssistantMessage,
    };
    reports.push(report);
    emitProgress(reporter, { issueNumber, phase: "worker", state: "fail", role, model, elapsedMs: report.durationMs, toolCalls: report.toolCalls, detail: report.disposition });
    return report;
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (parentSignal && cancelParent) parentSignal.removeEventListener("abort", cancelParent);
    session?.dispose();
  }
}

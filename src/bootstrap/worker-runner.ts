import { BootstrapError } from "./errors.js";
import { BootstrapReporter, WorkerFactory, WorkerReport, WorkerRole, WorkerSession, WorkerStats } from "./types.js";
import { extractAssistantTextDelta, parseReviewResultText } from "./reviewer.js";
import { emitProgress, progressToolName, redact } from "./utils.js";
import { classifyWorkerCompletion, createWorkerTerminalEvidence, observeWorkerEvent } from "../coordination/worker-terminal-result.js";

const DEFAULT_WORKER_TOKEN_WARN = Number.parseInt(process.env.PI_NEXT_WORKER_TOKEN_WARN ?? "20000", 10);
const DEFAULT_WORKER_TOKEN_HARD = Number.parseInt(process.env.PI_NEXT_WORKER_TOKEN_HARD ?? "50000", 10);

function workerStats(session: WorkerSession): { toolCalls: number; modelRounds?: number; usage?: WorkerStats; warning?: string } {
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
  return { toolCalls: stats.toolCalls ?? 0, modelRounds: stats.modelRounds, usage, warning };
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
  let tokenBudgetWarning: string | undefined;
  let rejectBudget: ((error: Error) => void) | undefined;
  const tokenWarn = Number.isFinite(DEFAULT_WORKER_TOKEN_WARN) && DEFAULT_WORKER_TOKEN_WARN > 0 ? DEFAULT_WORKER_TOKEN_WARN : 20_000;
  const tokenHard = Number.isFinite(DEFAULT_WORKER_TOKEN_HARD) && DEFAULT_WORKER_TOKEN_HARD > 0 ? DEFAULT_WORKER_TOKEN_HARD : 50_000;
  const progressStats = () => session ? workerStats(session) : { toolCalls };
  const checkTokenBudget = (stats: { usage?: WorkerStats; modelRounds?: number }): void => {
    const total = stats.usage?.total ?? 0;
    if (!total) return;
    if (!tokenBudgetWarning && total >= tokenWarn) {
      tokenBudgetWarning = `worker token warning: ${total} tokens reached warning threshold ${tokenWarn}`;
      emitProgress(reporter, { issueNumber, phase: "worker", state: "heartbeat", role, model, elapsedMs: Date.now() - started, toolCalls, modelRounds: stats.modelRounds, usage: stats.usage, detail: tokenBudgetWarning });
    }
    if (total >= tokenHard) {
      const reason = `worker token budget exhausted: ${total} tokens reached hard threshold ${tokenHard}`;
      controller.abort(reason);
      rejectBudget?.(new BootstrapError(reason));
    }
  };
  emitProgress(reporter, { issueNumber, phase: "worker", state: "start", role });
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastSafeProgress < heartbeatMs) return;
      const stats = progressStats();
      checkTokenBudget(stats);
      emitProgress(reporter, { issueNumber, phase: "worker", state: "heartbeat", role, model, elapsedMs: now - started, toolCalls: Math.max(toolCalls, stats.toolCalls), modelRounds: stats.modelRounds, usage: stats.usage });
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
        const stats = progressStats();
        checkTokenBudget(stats);
        emitProgress(reporter, { issueNumber, phase: "worker", state: "activity", role, model, tool, elapsedMs: Date.now() - started, toolCalls: Math.max(toolCalls, stats.toolCalls), modelRounds: stats.modelRounds, usage: stats.usage });
        lastSafeProgress = Date.now();
      } else if (typeof event === "object" && event !== null && (event as { type?: string }).type === "pi_next_usage") {
        const stats = progressStats();
        checkTokenBudget(stats);
        emitProgress(reporter, { issueNumber, phase: "worker", state: "heartbeat", role, model, elapsedMs: Date.now() - started, toolCalls: Math.max(toolCalls, stats.toolCalls), modelRounds: stats.modelRounds, usage: stats.usage });
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
    const budget = new Promise<never>((_, reject) => { rejectBudget = reject; });
    const promptRun = session.prompt(prompt);
    await Promise.race([promptRun, timeout, cancellation, budget]);
    const stats = workerStats(session);
    checkTokenBudget(stats);
    if ((stats.usage?.total ?? 0) >= tokenHard) throw new BootstrapError(`worker token budget exhausted: ${stats.usage?.total ?? 0} tokens reached hard threshold ${tokenHard}`);
    const classification = classifyWorkerCompletion(terminalEvidence);
    const report: WorkerReport = classification.ok
      ? {
          role,
          disposition: "completed",
          model,
          durationMs: Date.now() - started,
          toolCalls: Math.max(toolCalls, stats.toolCalls),
          modelRounds: stats.modelRounds,
          usage: stats.usage,
          telemetryWarning: tokenBudgetWarning ?? stats.warning,
          reviewResult: role === "review" ? parseReviewResultText(assistantText) : undefined,
          stopReason: terminalEvidence.stopReason,
          terminalResultKind: terminalEvidence.resultKind,
          terminalResultObserved: terminalEvidence.terminalResultObserved,
          assistantOutputObserved: terminalEvidence.assistantOutputObserved || assistantText.length > 0,
        }
      : {
          role,
          disposition: "failed",
          model,
          durationMs: Date.now() - started,
          toolCalls: Math.max(toolCalls, stats.toolCalls),
          modelRounds: stats.modelRounds,
          usage: stats.usage,
          telemetryWarning: tokenBudgetWarning ?? stats.warning,
          reason: redact(`${classification.code}: ${classification.detail}`),
          stopReason: terminalEvidence.stopReason,
          terminalResultKind: terminalEvidence.resultKind,
          terminalResultObserved: terminalEvidence.terminalResultObserved,
          assistantOutputObserved: terminalEvidence.assistantOutputObserved || assistantText.length > 0,
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
      modelRounds: report.modelRounds,
      usage: report.usage,
      detail: classification.ok ? report.telemetryWarning : (report.reason ?? report.disposition),
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
      modelRounds: stats.modelRounds,
      usage: stats.usage,
      telemetryWarning: tokenBudgetWarning ?? stats.warning,
      reason: redact(error instanceof Error ? error.message : String(error)),
      stopReason: terminalEvidence.stopReason,
      terminalResultKind: terminalEvidence.resultKind,
      terminalResultObserved: terminalEvidence.terminalResultObserved,
      assistantOutputObserved: terminalEvidence.assistantOutputObserved || assistantText.length > 0,
    };
    reports.push(report);
    emitProgress(reporter, { issueNumber, phase: "worker", state: "fail", role, model, elapsedMs: report.durationMs, toolCalls: report.toolCalls, modelRounds: report.modelRounds, usage: report.usage, detail: report.reason ?? report.disposition });
    return report;
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (parentSignal && cancelParent) parentSignal.removeEventListener("abort", cancelParent);
    session?.dispose();
  }
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  WORKER_ADAPTER_VERSION,
  type WorkerAdapter,
  type WorkerEventSink,
  type WorkerTask,
  type WorkerTerminalResult,
  type WorkerUsageTelemetry,
} from "../coordination/worker-adapter.ts";
import { createWorkerShellEnvironment, workerShellCommandDecision, type WorkerShellCommandDecision } from "../coordination/worker-shell-policy.ts";
import { classifyWorkerCompletion, createWorkerTerminalEvidence, observeWorkerEvent } from "../coordination/worker-terminal-result.ts";

async function runShell(cwd: string, decision: WorkerShellCommandDecision, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const { spawn } = await import("node:child_process");
  const sandbox = createWorkerShellEnvironment(decision.env ?? {});
  return await new Promise((resolveRun) => {
    const child = spawn(decision.command!, decision.args ?? [], { cwd, env: sandbox.env, signal, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const finish = (exitCode: number, chunk = "") => {
      sandbox.dispose();
      resolveRun({ exitCode, output: `${output}${chunk}`.slice(-8_000) });
    };
    child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function usageFromSession(session: any): { usage?: WorkerUsageTelemetry; toolCalls?: number; model?: string } {
  const stats = session.getSessionStats?.();
  const tokens = stats?.tokens ?? stats;
  const usage = tokens ? {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    totalTokens: tokens.total ?? 0,
    cost: stats?.cost ?? 0,
  } satisfies WorkerUsageTelemetry : undefined;
  const model = session.model?.provider && session.model.id ? `${session.model.provider}/${session.model.id}` : undefined;
  return { usage, toolCalls: stats?.toolCalls, model };
}

/** Real Pi WorkerAdapter used only by the explicit, credential-gated evaluation command. */
export class PiWorkerAdapter implements WorkerAdapter {
  readonly id = "pi";
  readonly version = WORKER_ADAPTER_VERSION;

  async run(task: WorkerTask, signal: AbortSignal, emit?: WorkerEventSink): Promise<WorkerTerminalResult> {
    const startedAt = new Date().toISOString();
    let session: any;
    let unsubscribe: (() => void) | undefined;
    try {
      const sdk = await import("@earendil-works/pi-coding-agent") as any;
      const modelRuntime = await sdk.ModelRuntime.create();
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new sdk.DefaultResourceLoader({
        cwd: task.cwd,
        agentDir: sdk.getAgentDir() || resolve(homedir(), ".pi", "agent"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "You are a bounded plain Pi coding worker. Follow the task packet and never act as lifecycle authority.",
      });
      await loader.reload();
      const readOnly = task.readOnly === true;
      const safeBash = sdk.defineTool({
        name: "safe_bash",
        label: "Safe shell",
        description: "Run a repository command in the supplied fixture workspace. Authority, main-branch, remote, and destructive worktree operations are refused.",
        parameters: Type.Object({ command: Type.String() }),
        execute: async (_id: string, params: { command: string }, toolSignal: AbortSignal | undefined) => {
          const decision = workerShellCommandDecision(params.command);
          if (!decision.allowed || !decision.command) return { content: [{ type: "text", text: `Refused: ${decision.reason ?? "command is outside the worker capability policy"}.` }], details: { refused: true } };
          const result = await runShell(task.cwd, decision, toolSignal);
          return { content: [{ type: "text", text: `exit ${result.exitCode}\n${result.output}`.slice(-8_000) }], details: { exitCode: result.exitCode } };
        },
      });
      const result = await sdk.createAgentSession({
        cwd: task.cwd,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        sessionManager: sdk.SessionManager.inMemory(task.cwd),
        tools: readOnly ? ["read", "grep", "find", "ls"] : ["read", "edit", "write", "grep", "find", "ls", "safe_bash"],
        customTools: readOnly ? [] : [safeBash],
      });
      session = result.session;
      emit?.({ type: "runtime", startedAt, lastActivityAt: startedAt, alive: true });
      let terminalEvidence = createWorkerTerminalEvidence();
      unsubscribe = session.subscribe?.((event: unknown) => {
        if (typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_execution_end") {
          emit?.({ type: "activity", phase: task.phase, kind: "tool", summary: "Pi tool execution completed" });
        }
        terminalEvidence = observeWorkerEvent(terminalEvidence, event);
      });
      await session.prompt(task.prompt);
      const telemetry = usageFromSession(session);
      const activity = telemetry.toolCalls === undefined ? undefined : { modelRounds: 1, toolCalls: telemetry.toolCalls, toolResults: telemetry.toolCalls };
      // A resolved session.prompt() is transport completion, not proof the model turn
      // succeeded (see #151) - only mechanically observed successful terminal
      // model/provider evidence counts as a passing worker attempt.
      const classification = classifyWorkerCompletion(terminalEvidence);
      if (!classification.ok) {
        return {
          ok: false,
          output: classification.detail,
          code: null,
          signal: null,
          telemetry: { status: terminalEvidence.terminalResultObserved ? "partial" : "unavailable", usage: telemetry.usage, activity, model: telemetry.model },
          failure: { code: classification.code, summary: classification.detail, diagnosticExcerpt: classification.detail.slice(-1_000) },
        };
      }
      return {
        ok: true,
        output: "Pi worker completed; independent grader determines pass/fail.",
        code: 0,
        signal: null,
        telemetry: { status: telemetry.usage ? "complete" : "partial", usage: telemetry.usage, activity, model: telemetry.model },
      };
    } catch (error) {
      const telemetry = session ? usageFromSession(session) : {};
      const summary = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: summary,
        code: null,
        signal: signal.aborted ? "SIGTERM" : null,
        telemetry: { status: telemetry.usage ? "partial" : "unavailable", usage: telemetry.usage, activity: telemetry.toolCalls === undefined ? undefined : { modelRounds: 1, toolCalls: telemetry.toolCalls, toolResults: telemetry.toolCalls }, model: telemetry.model },
        failure: { code: signal.aborted ? "pi_worker_cancelled" : "pi_worker_failed", summary, diagnosticExcerpt: summary.slice(-1_000) },
      };
    } finally {
      unsubscribe?.();
      if (signal.aborted) await session?.abort?.().catch?.(() => undefined);
      session?.dispose?.();
      emit?.({ type: "runtime", startedAt, lastActivityAt: new Date().toISOString(), alive: false });
    }
  }
}

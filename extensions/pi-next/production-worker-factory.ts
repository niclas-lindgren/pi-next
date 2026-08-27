import { existsSync } from "node:fs";

import type { WorkerFactory, WorkerRole, WorkerSession, WorkerStats } from "../../src/bootstrap/types.ts";
import { createWorkerDispatch } from "../../src/coordination/worker-dispatch.ts";
import { loadEffectiveSkillRegistry } from "../../src/skills/effective-registry.ts";
import type { IssueWorkerRunner, IssueWorkerRuntime } from "./util-core.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";

function rolePhase(role: WorkerRole): string {
  return role === "repair" ? "repair" : role === "review" ? "review" : "implementation";
}

class PiWorkerSession implements WorkerSession {
  private readonly listeners = new Set<(event: unknown) => void>();
  private telemetry: WorkerStats | undefined;
  private toolCalls = 0;
  model: { id?: string } | undefined;

  constructor(
    private readonly input: {
      runner: IssueWorkerRunner;
      cwd: string;
      role: WorkerRole;
      signal: AbortSignal;
      issueNumber: number;
      runId: string;
      coordinationCwd: string;
      onWorkLog?: (event: WorkerWorkLogEvent) => void;
      onWorkerState?: (runtime: IssueWorkerRuntime) => void;
    },
  ) {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }

  async abort(): Promise<void> {
    // Cancellation is delivered through the AbortSignal supplied to the child process runner.
  }

  getSessionStats(): Partial<WorkerStats> & { tokens?: Partial<WorkerStats>; toolCalls?: number } {
    return { ...(this.telemetry ?? {}), tokens: this.telemetry, toolCalls: this.toolCalls };
  }

  async prompt(text: string): Promise<void> {
    const phase = rolePhase(this.input.role);
    const dispatch = createWorkerDispatch({
      phase,
      hasPlan: existsSync(`${this.input.cwd}/.pi-next/PLAN.md`),
      issueNumber: this.input.issueNumber,
      skillRegistry: loadEffectiveSkillRegistry({ root: this.input.cwd }).registry,
    });
    const result = await this.input.runner(this.input.cwd, text, {
      signal: this.input.signal,
      issueNumber: this.input.issueNumber,
      runId: this.input.runId,
      phase,
      coordinationCwd: this.input.coordinationCwd,
      dispatch,
      readOnly: this.input.role === "review",
      onWorkerState: this.input.onWorkerState,
      onActivity: (event) => {
        this.toolCalls += 1;
        this.input.onWorkLog?.(event);
        this.emit({ type: "tool_execution_end", toolName: event.kind });
      },
    });
    this.model = result.telemetry.model ? { id: result.telemetry.model } : undefined;
    if (result.telemetry.usage) {
      this.telemetry = {
        input: result.telemetry.usage.input ?? 0,
        output: result.telemetry.usage.output ?? 0,
        cacheRead: result.telemetry.usage.cacheRead ?? 0,
        cacheWrite: result.telemetry.usage.cacheWrite ?? 0,
        total: result.telemetry.usage.totalTokens ?? 0,
        cost: result.telemetry.usage.cost ?? 0,
      };
    }
    this.toolCalls = Math.max(this.toolCalls, result.telemetry.activity?.toolCalls ?? 0);
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: result.ok ? "stop" : "error",
        errorMessage: result.failure?.summary || result.output || `worker exited code=${result.code ?? "signal"}`,
      },
    });
    if (!result.ok) throw new Error(result.failure?.summary || result.output || `worker exited code=${result.code ?? "signal"}`);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function createPiWorkerFactory(input: {
  runner: IssueWorkerRunner;
  issueNumber: number;
  runId: string;
  coordinationCwd: string;
  onWorkLog?: (event: WorkerWorkLogEvent) => void;
  onWorkerState?: (runtime: IssueWorkerRuntime) => void;
}): WorkerFactory {
  return async ({ cwd, role, signal }) => new PiWorkerSession({ ...input, cwd, role, signal });
}

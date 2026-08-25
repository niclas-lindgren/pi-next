import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import {
  createSupervisorRuntime,
  currentSupervisorRuntime,
  type GenerationTelemetryContext,
} from "./supervisor-runtime.ts";

export type { GenerationTelemetryContext } from "./supervisor-runtime.ts";
import { listLoopStates, readLoopState } from "./loop-state.ts";
import { classifyLoopStates, selectCurrentLoop } from "./loop-status.ts";
import type {
  ExtensionGeneration,
  GenerationTeardownDiagnostics,
  IssueWorkerRuntime,
} from "./util-core.ts";
import type { WorkerWorkLogPhase } from "./worker-activity.ts";

/**
 * Compatibility accessors for code executing inside a supervisor context.
 * Outside that context there is deliberately no active generation: direct
 * commands must not observe or dispose another run's worker.
 */
export function currentGeneration(): ExtensionGeneration | null {
  return currentSupervisorRuntime()?.currentGeneration() ?? null;
}

/** Creates an isolated generation for legacy direct callers. */
export async function beginGeneration(
  reason: string,
  telemetry?: GenerationTelemetryContext,
): Promise<ExtensionGeneration> {
  return createSupervisorRuntime().beginGeneration(reason, telemetry);
}

export async function teardownWithTelemetry(
  target: ExtensionGeneration,
  reason: string,
  telemetry?: GenerationTelemetryContext,
): Promise<GenerationTeardownDiagnostics> {
  const diagnostics = await target.teardown(reason);
  if (telemetry) {
    recordLifecycleEvent(telemetry.cwd, {
      event: "generation_teardown",
      issueNumber: telemetry.issueNumber ?? 0,
      runId: telemetry.runId,
      outcome: diagnostics.timedOut ? "failure" : "success",
      reasonCode: diagnostics.timedOut ? "teardown_timeout" : undefined,
      generation: diagnostics,
    });
  }
  return diagnostics;
}

export type SupervisorPhase =
  | "idle"
  | "launching"
  | "running"
  | "aborted"
  | "settled";

export interface SupervisorStatus {
  /**
   * --- Durable controller state (from the persisted loop-state file; true
   * regardless of whether any process is currently running it). ---
   */
  runId: string | null;
  phase: SupervisorPhase;
  issueNumber: number | null;
  workspace: string | null;
  step: number;
  remainingIssues: number;
  lastReason?: string;
  /** When the current durable step started (ISO timestamp), if any. */
  workerStartedAt: string | null;
  /**
   * --- Actual live-process state (independent of worker-telemetry.ts /
   * #599's structured child event stream; that stream may enrich `phase`
   * with planning/editing/testing detail, per #607, but is never required
   * for this baseline liveness signal). ---
   */
  /** Whether a live pi-next worker generation (an active child worker cycle) exists right now. */
  workerAlive: boolean;
  /** Explicit liveness state; `unknown` is never rendered as worker active. */
  workerLiveness: "alive" | "not-running" | "unknown";
  workerPid: number | null;
  lastActivityAt: string | null;
  /** Elapsed time since `workerStartedAt`, only meaningful while `workerAlive`. */
  elapsedMs: number | null;
  /** Best-effort lifecycle phase from the structured worker activity stream. */
  workerPhase?: WorkerWorkLogPhase;
}

function buildSupervisorStatus(
  cwd: string,
  runId: string | null,
  phase: SupervisorPhase,
  workerRuntime?: IssueWorkerRuntime | null,
  workerPhase?: WorkerWorkLogPhase,
): SupervisorStatus {
  const persisted = runId ? readLoopState(cwd, runId) : null;
  const effectivePhase: SupervisorPhase = persisted && persisted.status !== "running"
    ? persisted.status === "interrupted" || persisted.status === "failed"
      ? "aborted"
      : "settled"
    : phase;
  // A terminal durable state is itself a lifecycle fence: once persisted,
  // absence of a live runtime must render as not-running, never as an
  // unknown/stale worker inherited from the preceding generation.
  const workerLiveness = workerRuntime
    ? workerRuntime.alive
      ? "alive"
      : "not-running"
    : persisted && persisted.status !== "running"
      ? "not-running"
      : "unknown";
  const workerAlive = workerLiveness === "alive";
  const workerStartedAt = workerRuntime?.startedAt ?? persisted?.stepStartedAt ?? null;
  const startedMs = workerStartedAt ? Date.parse(workerStartedAt) : NaN;
  return {
    runId,
    phase: effectivePhase,
    issueNumber: persisted?.activeIssueNumber ?? null,
    workspace: persisted?.activeWorkspace ?? null,
    step: persisted?.step ?? 0,
    remainingIssues: persisted?.remainingIssues ?? 0,
    lastReason: persisted?.lastReason,
    workerStartedAt,
    workerAlive,
    workerLiveness,
    workerPid: workerRuntime?.pid ?? null,
    lastActivityAt: workerRuntime?.lastActivityAt ?? null,
    elapsedMs:
      workerAlive && Number.isFinite(startedMs)
        ? Math.max(0, Date.now() - startedMs)
        : null,
    workerPhase: workerAlive ? workerPhase : undefined,
  };
}

/**
 * Baseline status for a run, for status surfaces (e.g. the `pi-next-status`
 * command's auto-heartbeat) that have no live supervisor instance in hand,
 * only a `cwd`. With `preferredRunId`, reports on exactly that run (present
 * or not); otherwise requires the caller's session identity and selects only
 * that session's running record. This is a display convenience only and
 * never an ownership decision (that remains the fresh GitHub lease).
 */
export function currentSupervisorStatus(
  cwd: string,
  preferredRunId?: string,
  ownerSessionId?: string,
): SupervisorStatus | null {
  if (preferredRunId) {
    return buildSupervisorStatus(cwd, preferredRunId, "running");
  }
  // Never infer a display owner from the repository's newest running record.
  // A caller without an explicit run must first provide its session identity.
  if (!ownerSessionId) return null;
  const running = selectCurrentLoop(
    classifyLoopStates(cwd, listLoopStates(cwd)),
    undefined,
    ownerSessionId,
  ).current;
  if (!running) return null;
  return buildSupervisorStatus(
    cwd,
    running.state.runId,
    running.presentation === "running" ? "running" : "aborted",
  );
}

/**
 * One-line human status distinguishing durable controller state from an
 * actually-live worker process, e.g.:
 *   "#123 step 4/40 · controller running · worker alive · 12s"
 *   "#123 step 4/40 · controller running · worker not running (interrupted)"
 */
export function formatSupervisorStatus(status: SupervisorStatus): string {
  const issue = status.issueNumber ? `#${status.issueNumber}` : "no active issue";
  const step = status.step > 0 ? `step ${status.step}` : "starting";
  const worker = status.workerLiveness === "alive"
    ? ["settled", "aborted"].includes(status.phase)
      ? `worker orphaned (still alive)${status.lastReason ? ` (${status.lastReason})` : ""}`
      : `worker alive${status.elapsedMs != null ? ` · ${Math.round(status.elapsedMs / 1_000)}s` : ""}`
    : status.workerLiveness === "unknown"
      ? "worker liveness unknown"
      : `worker not running${status.lastReason ? ` (${status.lastReason})` : ""}`;
  return `${issue} · ${step} · controller ${status.phase} · ${worker}`;
}

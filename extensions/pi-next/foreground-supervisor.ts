import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { getLiveCtx, sessionIdentity } from "./live-ctx.ts";
import {
  prepareAbandonedAutoResume,
  recoverableAbandonedAutoRun,
} from "./commands-recovery.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import {
  createSupervisorRuntime,
  currentSupervisorRuntime,
  withSupervisorRuntime,
  type GenerationTelemetryContext,
  type SupervisorRuntime,
} from "./supervisor-runtime.ts";

export type { GenerationTelemetryContext } from "./supervisor-runtime.ts";
import {
  listLoopStates,
  loopNow,
  loopStateFile,
  readLoopState,
  type LoopState,
} from "./loop-state.ts";
import { writeJsonAtomic } from "./util.ts";
import type {
  ExtensionGeneration,
  GenerationTeardownDiagnostics,
  IssueWorkerRuntime,
} from "./util-core.ts";
import type { WorkerWorkLogEvent, WorkerWorkLogPhase } from "./worker-activity.ts";
import type { WorkerWorkLogSink } from "./work-log.ts";
import { runOwnedIssueCycle } from "./loop.ts";

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

export interface RecoveryOutcome {
  /** True when an authoritative-lease-owned interrupted run was resumed. */
  recovered: boolean;
  runId?: string;
  issueNumber?: number;
  /** Uncommitted issue-worktree files preserved (never reset/stashed) for the fresh worker to inspect. */
  dirtyFiles?: string[];
  /** Set when a candidate run existed but recovery could not proceed safely. */
  blockedReason?: string;
}

function buildSupervisorStatus(
  cwd: string,
  runId: string | null,
  phase: SupervisorPhase,
  ownedGeneration?: ExtensionGeneration | null,
  workerRuntime?: IssueWorkerRuntime | null,
  workerPhase?: WorkerWorkLogPhase,
): SupervisorStatus {
  const persisted = runId ? readLoopState(cwd, runId) : null;
  const effectivePhase: SupervisorPhase = persisted && persisted.status !== "running"
    ? persisted.status === "interrupted" || persisted.status === "failed"
      ? "aborted"
      : "settled"
    : phase;
  // A generation is only a lifecycle boundary. It is not evidence that a
  // child PID exists; workerRuntime is the sole source for worker liveness.
  void ownedGeneration;
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
 * command's auto-heartbeat) that have no live `ForegroundSupervisor`
 * instance in hand, only a `cwd`. With `preferredRunId`, reports on exactly
 * that run (present or not); otherwise requires the caller's session identity
 * and selects only that session's running record. This is a display
 * convenience only and never an ownership decision (that remains the fresh
 * GitHub lease, per `recoverOnStart`).
 */
const liveSupervisors = new Map<string, ForegroundSupervisor>();

function supervisorKey(cwd: string, runId: string): string {
  return `${cwd}\u0000${runId}`;
}

export function currentSupervisorStatus(
  cwd: string,
  preferredRunId?: string,
  ownerSessionId?: string,
): SupervisorStatus | null {
  if (preferredRunId) {
    const live = liveSupervisors.get(supervisorKey(cwd, preferredRunId));
    return live
      ? live.status()
      : buildSupervisorStatus(cwd, preferredRunId, "running");
  }
  // Never infer a display owner from the repository's newest running record.
  // A caller without an explicit run must first provide its session identity.
  if (!ownerSessionId) return null;
  const running = listLoopStates(cwd)
    .filter((state) => state.status === "running" && state.sessionId === ownerSessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!running) return null;
  const live = liveSupervisors.get(supervisorKey(cwd, running.runId));
  return live
    ? live.status()
    : buildSupervisorStatus(cwd, running.runId, "running");
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

/**
 * ForegroundSupervisor is the single foreground-visible owner of one
 * isolated pi-next worker at a time.
 *
 * `/pi-next auto` (and `resume`) drive this abstraction — claim, run,
 * reconcile, select-next-issue — as one continuous supervisor activity
 * with an explicit launch/abort/status/reconcile lifecycle, instead of
 * callers reaching directly into the distributed loop-controller/
 * loop-state flow themselves. See GitHub issue #612.
 */
export class ForegroundSupervisor {
  private phase: SupervisorPhase = "idle";
  private runId: string | null = null;
  /**
   * `ExtensionCommandContext` is session-scoped and becomes stale after
   * `newSession()`.  Keep only its immutable data for status/lifecycle
   * bookkeeping; host calls use the live-context registry at the boundary.
   */
  private readonly cwd: string;

  private readonly runtime: SupervisorRuntime;
  private workerRuntime: IssueWorkerRuntime | null = null;
  private workerPhase: WorkerWorkLogPhase | undefined;

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly onWorkLog?: WorkerWorkLogSink,
    private readonly onWorkerState?: (runtime: IssueWorkerRuntime) => void,
  ) {
    this.cwd = ctx.cwd;
    this.runtime = createSupervisorRuntime();
  }

  /**
   * Authority-first, issue-centric recovery on supervisor start (#612).
   *
   * The only question that decides recovery is "does the authoritative GitHub
   * issue lease identify this local run as its owner?" — never local
   * status/mtime ordering, a `running`-looking loop-state file, or a newer-
   * timestamp record. `recoverableAbandonedAutoRun` reads the current
   * authoritative lease via the reusable `src/coordination/` module and
   * returns at most the one local run that (a) still matches that lease and
   * (b) has no live local worker process. A matching stale lease is passed to
   * the normal resume path, where `reconcileIssueLeaseForResume` performs the
   * bounded CAS takeover; foreign or missing authority remains ineligible.
   * Every other historical loop record for the same or a different issue is
   * ignored and can never compete for ownership. When a genuine owner is
   * found, its canonical `.worktrees/issue-N` is resumed without resetting,
   * stashing, or auto-committing any dirty changes —
   * `prepareAbandonedAutoResume` only marks the interrupted transition settled
   * and preserves the diff — and the fresh worker is launched through the
   * normal resume path so it is explicitly told (via the resume prompt) that
   * it is recovering interrupted work and must inspect/reconcile the existing
   * diff.
   */
  static async recoverOnStart(
    ctx: ExtensionCommandContext,
  ): Promise<RecoveryOutcome> {
    const abandoned = await recoverableAbandonedAutoRun(ctx.cwd);
    if (!abandoned) return { recovered: false };
    const prepared = await prepareAbandonedAutoResume(
      ctx.cwd,
      abandoned,
      sessionIdentity(ctx),
    );
    if (!prepared.ok) {
      return { recovered: false, blockedReason: prepared.reason };
    }
    const supervisor = new ForegroundSupervisor(ctx);
    const state = readLoopState(ctx.cwd, abandoned.runId);
    if (!state) {
      return { recovered: false, blockedReason: "Recovered run state disappeared" };
    }
    await supervisor.launch(state);
    return {
      recovered: true,
      runId: abandoned.runId,
      issueNumber: abandoned.activeIssueNumber ?? undefined,
      dirtyFiles: prepared.dirtyFiles,
    };
  }

  /** Begin a worker turn owned by this supervisor (useful to lifecycle adapters). */
  async beginGeneration(
    reason: string,
    issueNumber?: number,
  ): Promise<ExtensionGeneration> {
    return this.runtime.beginGeneration(reason, this.runId
      ? { cwd: this.cwd, runId: this.runId, issueNumber }
      : undefined);
  }

  /** Combined supervisor + durable loop-state snapshot for status surfaces. */
  status(): SupervisorStatus {
    return buildSupervisorStatus(
      this.cwd,
      this.runId,
      this.phase,
      this.runtime.currentGeneration(),
      this.workerRuntime,
      this.workerPhase,
    );
  }

  /**
   * Owns one run's worth of isolated-worker cycles: claim issue -> ensure
   * canonical worktree -> spawn worker -> reconcile durable result ->
   * complete/defer/release -> select next issue, repeated until the run
   * settles (completed, blocked, or stopped). The supervisor owns the
   * issue-selection progression; `runOwnedIssueCycle` is only the bounded
   * claim/worker/reconcile primitive for one issue.
   */
  async launch(initial: LoopState): Promise<LoopState | null> {
    this.runId = initial.runId;
    liveSupervisors.set(supervisorKey(this.cwd, this.runId), this);
    this.phase = "launching";
    try {
      this.phase = "running";
      await withSupervisorRuntime(this.runtime, async () => {
        let state = initial;
        while (state.status === "running" && state.remainingIssues > 0) {
          this.workerPhase = undefined;
          this.workerRuntime = null;
          // A worker/session transition may have invalidated the context
          // passed to the constructor. The cycle itself performs host calls,
          // so hand it the current live context while status remains data-only.
          const liveCtx = getLiveCtx() ?? this.ctx;
          state = await runOwnedIssueCycle(
            liveCtx,
            state,
            this.runtime,
            (event: WorkerWorkLogEvent) => {
              this.workerPhase = event.phase;
              this.onWorkLog?.(event);
            },
            (runtime) => {
              this.workerRuntime = runtime;
              this.onWorkerState?.(runtime);
            },
          );
        }
      });
      // The issue-cycle returns at the queue boundary, before another
      // controller turn can normalize a zero remaining count. Persist the
      // terminal state here so the footer and later status queries agree.
      const settled = readLoopState(this.cwd, this.runId);
      if (settled?.status === "running" && settled.remainingIssues <= 0) {
        writeJsonAtomic(loopStateFile(this.cwd, this.runId), {
          ...settled,
          status: "completed",
          activeIssueNumber: undefined,
          activeWorkspace: undefined,
          activeLease: undefined,
          updatedAt: loopNow(),
          lastReason: "Requested issue count completed",
        });
      }
      // The worker callback reports its final PID state before its promise
      // settles. Clear the per-generation snapshot before terminal status is
      // exposed so a prior issue cannot make a later footer say "worker
      // alive". A genuinely surviving child is abnormal and remains visible
      // as an explicit orphan/teardown failure instead of a normal terminal
      // state.
      const terminal = readLoopState(this.cwd, this.runId);
      if (terminal?.status !== "running" && this.workerRuntime?.alive) {
        writeJsonAtomic(loopStateFile(this.cwd, this.runId), {
          ...terminal,
          status: "failed",
          updatedAt: loopNow(),
          lastReason: "Worker teardown failed: an owned worker survived terminal transition (orphaned worker)",
        });
      }
      this.workerRuntime = null;
      this.workerPhase = undefined;
      this.phase = "settled";
    } catch (error) {
      this.phase = "aborted";
      throw error;
    } finally {
      // Also clear on exceptional launch paths; durable interrupted/failed
      // state is rendered without mutable runtime data from the old issue.
      this.workerRuntime = null;
      this.workerPhase = undefined;
      liveSupervisors.delete(supervisorKey(this.cwd, this.runId));
    }
    return this.reconcile();
  }

  /**
   * Cancellation of the owned run: marks the durable state stopped so a
   * cooperative step boundary winds down cleanly, and — since this class
   * alone owns the active worker generation — also signals the live worker
   * generation directly and waits (bounded) for its subprocess(es) to
   * terminate. This guarantees a normal `abort()` never leaves a detached
   * worker child alive; any worktree changes the worker already made on
   * disk are left untouched (no reset/stash/commit here), only the process
   * is signalled to stop.
   */
  async abort(reason: string): Promise<LoopState | null> {
    const generation = this.runtime.currentGeneration();
    const teardown = generation && !generation.isDisposed()
      ? await this.runtime.teardown(generation, reason, this.runId
          ? { cwd: this.cwd, runId: this.runId }
          : undefined)
      : undefined;
    if (!this.runId) return null;
    const current = readLoopState(this.cwd, this.runId);
    if (!current) return null;
    const orphaned = Boolean(teardown?.timedOut || this.workerRuntime?.alive);
    const next: LoopState = {
      ...current,
      status: orphaned ? "failed" : "stopped",
      stopRequested: true,
      lastReason: orphaned
        ? `${reason}; worker teardown failed (orphaned worker)`
        : reason,
      updatedAt: loopNow(),
    };
    writeJsonAtomic(loopStateFile(this.cwd, this.runId), next);
    if (!orphaned) {
      this.workerRuntime = null;
      this.workerPhase = undefined;
    }
    this.phase = "aborted";
    return next;
  }

  /** Explicit accessor for the durable result of the run this instance owns. */
  reconcile(): LoopState | null {
    if (!this.runId) return null;
    return readLoopState(this.cwd, this.runId);
  }
}

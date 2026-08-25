import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

import { runLifecycleScheduler, runSingleIssueLifecycle, LifecycleSchedulerClaimConflict, type IssueLifecycleExecutor, type LifecycleReporter, type LifecycleSchedulerClaimHandle, type LifecycleSchedulerResult, type UnifiedLifecycleResult } from "../../src/lifecycle/index.ts";
import type { BootstrapDependencies, BootstrapOptions, Issue } from "../../src/bootstrap/types.ts";
import { loadPiNextConfig, type PiNextConfig } from "../../src/coordination/config.ts";
import { createWorkAuthority, type AuthorityWorkItem, type WorkAuthorityAdapter } from "../../src/coordination/work-authority.ts";
import { candidateShortlist } from "./issue-candidates.ts";
import {
  GitHubIssueLeaseAuthority,
  claimIssueLease,
  startIssueLeaseHeartbeat,
  releaseIssueLease,
  LeaseConflictError,
  ISSUE_LEASE_DURATION_MS,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { PiWorkerAdapter, issueWorkerRunnerFromAdapter, type PiWorkerCompatibleAdapter } from "./pi-worker-adapter.ts";
import type { IssueWorkerRunner, IssueWorkerRuntime } from "./util-core.ts";
import { loopNow, loopStateFile, emptyLoopMetrics, MAX_STEPS, type LoopState } from "./loop-state.ts";
import { writeJsonAtomic } from "./util.ts";
import { recordPiLifecycleJournal } from "./lifecycle-journal.ts";
import { sessionIdentity } from "./live-ctx.ts";
import type { WorkerWorkLogEvent } from "./worker-activity.ts";
import { createPiWorkerFactory } from "./production-worker-factory.ts";

function issueFromAuthority(item: AuthorityWorkItem): Issue {
  return {
    number: item.number ?? Number.parseInt(item.id, 10),
    title: item.title,
    body: item.body,
    state: item.state.toLowerCase() === "closed" || item.states.some((state) => state.toLowerCase() === "done") ? "CLOSED" : "OPEN",
    labels: item.states,
    comments: item.comments.map((comment) => ({
      author: { login: comment.author },
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
  };
}

export interface ProductionLifecycleDeps {
  config?: PiNextConfig;
  authority?: WorkAuthorityAdapter;
  leaseAuthority?: IssueLeaseAuthority;
  adapter?: PiWorkerCompatibleAdapter;
  worker?: IssueWorkerRunner;
  onWorkLog?: (event: WorkerWorkLogEvent) => void;
  onWorkerState?: (runtime: IssueWorkerRuntime) => void;
  reporter?: LifecycleReporter;
  bootstrap?: Omit<BootstrapDependencies, "fetchIssue" | "createWorker" | "reporter">;
}

export interface ProductionSingleIssueOptions {
  cwd: string;
  issueNumber: number;
  entry: "explicit" | "auto" | "monitor";
  runId: string;
  allowRepair?: boolean;
  review?: boolean;
  finalize?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function productionDependencies(cwd: string, options: ProductionSingleIssueOptions, deps: ProductionLifecycleDeps): BootstrapDependencies {
  const config = deps.config ?? loadPiNextConfig(cwd);
  const authority = deps.authority ?? createWorkAuthority(cwd, config);
  const adapter = deps.adapter ?? new PiWorkerAdapter(deps.worker);
  const runner = deps.worker ?? issueWorkerRunnerFromAdapter(adapter);
  return {
    ...deps.bootstrap,
    reporter: deps.reporter,
    fetchIssue: async (issueNumber) => issueFromAuthority(await authority.get(String(issueNumber))),
    createWorker: createPiWorkerFactory({
      runner,
      issueNumber: options.issueNumber,
      runId: options.runId,
      coordinationCwd: cwd,
      onWorkLog: deps.onWorkLog,
      onWorkerState: deps.onWorkerState,
    }),
  };
}

/** Production single-issue adapter over the canonical lifecycle kernel. */
export async function runProductionSingleIssueLifecycle(
  options: ProductionSingleIssueOptions,
  deps: ProductionLifecycleDeps = {},
  execute?: IssueLifecycleExecutor,
): Promise<UnifiedLifecycleResult> {
  const dependencies = productionDependencies(options.cwd, options, deps);
  const result = await runSingleIssueLifecycle({
    cwd: options.cwd,
    workItem: { issueNumber: options.issueNumber },
    entry: options.entry,
    runId: options.runId,
    allowRepair: options.allowRepair ?? true,
    review: options.review ?? false,
    finalize: options.finalize ?? true,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  }, dependencies, execute);
  recordPiLifecycleJournal(options.cwd, {
    runId: options.runId,
    issueNumber: options.issueNumber,
    event: "authority_reconciled",
    payload: {
      phase: result.projection.phase,
      reasonCode: result.disposition,
      source: options.entry,
    },
  });
  return result;
}

export interface ProductionSchedulerOptions {
  cwd: string;
  ctx?: ExtensionCommandContext;
  entry: "auto" | "monitor";
  requestedIssues: number;
  runId?: string;
  onWorkLog?: (event: WorkerWorkLogEvent) => void;
  onWorkerState?: (runtime: IssueWorkerRuntime) => void;
  reporter?: LifecycleReporter;
  signal?: AbortSignal;
}

function initialLoopState(cwd: string, runId: string, sessionId: string | undefined, requestedIssues: number): LoopState {
  const createdAt = loopNow();
  return {
    version: 1,
    runId,
    sessionId,
    requestedIssues,
    remainingIssues: requestedIssues,
    step: 0,
    settledStep: 0,
    maxSteps: Math.min(MAX_STEPS, Math.max(10, requestedIssues * 20)),
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt,
    updatedAt: createdAt,
    metrics: emptyLoopMetrics(),
    coordinationCwd: cwd,
  };
}

function updateProjectionState(cwd: string, runId: string, projection: UnifiedLifecycleResult["projection"]): void {
  const statePath = loopStateFile(cwd, runId);
  if (!existsSync(statePath)) return;
  const current = JSON.parse(readFileSync(statePath, "utf8")) as LoopState;
  writeJsonAtomic(statePath, {
    ...current,
    activeIssueNumber: projection.activeIssue,
    status: projection.phase === "terminal" ? current.status : "running",
    updatedAt: loopNow(),
    lastReason: projection.terminalDisposition ? `lifecycle ${projection.terminalDisposition}` : `lifecycle phase ${projection.phase}${projection.workerLive ? " (worker live)" : ""}`,
  });
}

/** Queue-level production adapter: discovery/continuation only, no lifecycle state machine. */
export async function runProductionLifecycleScheduler(
  options: ProductionSchedulerOptions,
  deps: ProductionLifecycleDeps = {},
  execute?: IssueLifecycleExecutor,
): Promise<LifecycleSchedulerResult> {
  const config = deps.config ?? loadPiNextConfig(options.cwd);
  const authority = deps.authority ?? createWorkAuthority(options.cwd, config);
  const leaseAuthority = deps.leaseAuthority ?? new GitHubIssueLeaseAuthority(options.cwd);
  const requestedIssues = Math.max(0, Math.trunc(options.requestedIssues));
  const runId = options.runId ?? `${loopNow().replace(/[:.]/g, "-")}-${process.pid}`;
  const state = initialLoopState(options.cwd, runId, options.ctx ? sessionIdentity(options.ctx) : undefined, requestedIssues);
  writeJsonAtomic(loopStateFile(options.cwd, runId), state);
  const reporter: LifecycleReporter = (event) => {
    if (event.projection) updateProjectionState(options.cwd, runId, event.projection);
    options.reporter?.(event);
  };
  // Fresh-owner races lost after selection are excluded for the rest of this
  // scheduler run, mirroring the legacy loop's scheduler-skip bookkeeping
  // (#146): a race is a local candidate skip, never a global stop.
  const raceExcluded: number[] = [];
  const result = await runLifecycleScheduler({
    cwd: options.cwd,
    entry: options.entry,
    runId,
    allowRepair: true,
    review: false,
    finalize: true,
    signal: options.signal,
    reporter,
    policy: { maxIssues: requestedIssues, continueAfterIssueLocalFailure: true },
    discover: async (completed) => {
      const shortlist = await candidateShortlist(options.cwd, {
        authority,
        config,
        leaseAuthority,
        completedIssues: completed.filter((item) => item.disposition === "pass" || item.disposition === "already-satisfied").map((item) => item.issueNumber),
        deferredIssues: completed.filter((item) => item.disposition !== "pass" && item.disposition !== "already-satisfied").map((item) => item.issueNumber),
        schedulerExcludedIssues: raceExcluded,
      });
      return shortlist.candidateIssueNumber ? { issueNumber: shortlist.candidateIssueNumber } : undefined;
    },
    // Selection above only reads leases as an optimization; absence there is
    // never proof of ownership. This performs the actual CAS claim that
    // explicit `/pi-next <issue>` already performs before entering the
    // shared kernel, so auto/monitor share the identical ownership fence.
    claim: async (selection) => {
      const acquiredAt = new Date();
      let lease;
      try {
        lease = await claimIssueLease(leaseAuthority, {
          issueNumber: selection.issueNumber,
          agent: "pi-next",
          runId: `${runId}:issue-${selection.issueNumber}`,
          sessionId: `${runId}-issue-${selection.issueNumber}`,
          acquiredAt: acquiredAt.toISOString(),
          expiresAt: new Date(acquiredAt.getTime() + ISSUE_LEASE_DURATION_MS).toISOString(),
        }, acquiredAt, { cwd: options.cwd, recordEvent: recordLifecycleEvent });
      } catch (error) {
        if (error instanceof LeaseConflictError) throw new LifecycleSchedulerClaimConflict(selection, error);
        throw error;
      }
      const heartbeat = startIssueLeaseHeartbeat(leaseAuthority, lease, { signal: options.signal });
      const release: LifecycleSchedulerClaimHandle["release"] = async () => {
        await heartbeat.stop();
        try {
          await releaseIssueLease(leaseAuthority, heartbeat.getLease(), { cwd: options.cwd, recordEvent: recordLifecycleEvent });
        } catch (error) {
          // A conflict here means a different fresh owner already recovered
          // this lease (e.g. after a takeover); nothing to release.
          if (!(error instanceof LeaseConflictError)) throw error;
        }
      };
      return { release };
    },
    onClaimConflict: (selection) => {
      raceExcluded.push(selection.issueNumber);
      recordLifecycleEvent(options.cwd, {
        event: "scheduler_skip",
        issueNumber: selection.issueNumber,
        runId,
        outcome: "skip",
        reasonCode: "fresh_owner",
      });
    },
    requeryAuthority: async (lifecycleResult) => { await authority.get(String(lifecycleResult.issueNumber)); },
  }, {
    ...deps.bootstrap,
    reporter,
  }, async (bootstrapOptions: BootstrapOptions, dependencies?: BootstrapDependencies) => {
    const perIssueDeps = productionDependencies(options.cwd, {
      cwd: options.cwd,
      issueNumber: bootstrapOptions.issueNumber,
      entry: options.entry,
      runId: `${runId}:issue-${bootstrapOptions.issueNumber}`,
      allowRepair: bootstrapOptions.allowRepair,
      review: bootstrapOptions.review,
      finalize: true,
      timeoutMs: bootstrapOptions.timeoutMs,
      signal: bootstrapOptions.signal,
    }, { ...deps, authority, config, onWorkLog: options.onWorkLog, onWorkerState: options.onWorkerState, reporter });
    return execute
      ? execute(bootstrapOptions, { ...dependencies, ...perIssueDeps })
      : (await import("../../src/bootstrap/supervisor.ts")).runBootstrap(bootstrapOptions, { ...dependencies, ...perIssueDeps });
  });
  const latest = result.latest;
  const finalState = {
    ...(JSON.parse(readFileSync(loopStateFile(options.cwd, runId), "utf8")) as LoopState),
    status: result.disposition,
    remainingIssues: Math.max(0, requestedIssues - result.settled),
    completedIssues: result.results.filter((item) => item.disposition === "pass" || item.disposition === "already-satisfied").map((item) => item.issueNumber),
    deferredIssues: result.results.filter((item) => item.disposition !== "pass" && item.disposition !== "already-satisfied").map((item) => ({ issueNumber: item.issueNumber, reason: String(item.disposition), deferredAt: loopNow(), kind: "blocked" as const })),
    activeIssueNumber: latest?.issueNumber,
    updatedAt: loopNow(),
    lastOutcome: result.disposition === "completed"
      ? "done" as const
      : result.disposition === "idle"
        ? "idle" as const
        : result.disposition === "budget-yield"
          ? "yield_issue" as const
          : result.disposition === "cancelled"
            ? "cancelled" as const
            : "block_issue" as const,
    lastReason: `unified lifecycle scheduler ${result.disposition}${latest ? ` after #${latest.issueNumber} (${latest.disposition})` : ""}`,
  };
  writeJsonAtomic(loopStateFile(options.cwd, runId), finalState);
  return result;
}

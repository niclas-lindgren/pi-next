import { type IssueLifecycleExecutor, type LifecycleEntryPoint, type LifecycleReporter, runSingleIssueLifecycle, type SingleIssueLifecycleDependencies, type SingleIssueLifecycleOptions, type UnifiedLifecycleResult } from "./kernel.js";

export interface LifecycleSchedulerSelection {
  issueNumber: number;
}

export interface LifecycleSchedulerPolicy {
  maxIssues: number;
  continueAfterIssueLocalFailure?: boolean;
}

export interface LifecycleSchedulerClaimHandle {
  release: () => Promise<void>;
}

/**
 * Atomically claims authoritative ownership of a scheduler-selected issue
 * before it enters the canonical single-issue lifecycle boundary. Must
 * throw {@link LifecycleSchedulerClaimConflict} when another owner already
 * holds a fresh claim; any other error is a discovery/authority failure and
 * must propagate rather than be treated as an available candidate.
 */
export type LifecycleSchedulerClaim = (
  selection: LifecycleSchedulerSelection,
) => Promise<LifecycleSchedulerClaimHandle>;

/**
 * Raised by a {@link LifecycleSchedulerClaim} to signal that the selected
 * candidate lost an ownership race. This is a scheduler-local candidate
 * skip, never a worker failure and never a reason to stop the run.
 */
export class LifecycleSchedulerClaimConflict extends Error {
  constructor(readonly selection: LifecycleSchedulerSelection, cause?: unknown) {
    super(`Issue #${selection.issueNumber} lost the scheduler claim race`);
    this.name = "LifecycleSchedulerClaimConflict";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface LifecycleSchedulerOptions extends Omit<SingleIssueLifecycleOptions, "workItem" | "entry" | "runId"> {
  entry?: Extract<LifecycleEntryPoint, "auto" | "monitor">;
  runId: string;
  policy: LifecycleSchedulerPolicy;
  discover: (completed: readonly UnifiedLifecycleResult[]) => Promise<LifecycleSchedulerSelection | undefined>;
  /**
   * Optional atomic ownership claim performed immediately before a selected
   * candidate enters the canonical single-issue lifecycle, and released
   * immediately after it terminates. Omitting this preserves prior
   * behavior for callers (e.g. bootstrap) that already own ownership
   * semantics elsewhere; production auto/monitor scheduling must supply it
   * so every entry point claims through the same fence.
   */
  claim?: LifecycleSchedulerClaim;
  onClaimConflict?: (selection: LifecycleSchedulerSelection, error: LifecycleSchedulerClaimConflict) => void;
  requeryAuthority?: (result: UnifiedLifecycleResult) => Promise<void>;
  reporter?: LifecycleReporter;
}

export interface LifecycleSchedulerResult {
  runId: string;
  entry: "auto" | "monitor";
  settled: number;
  results: UnifiedLifecycleResult[];
  disposition: "idle" | "completed" | "budget-yield" | "blocked" | "cancelled";
  latest?: UnifiedLifecycleResult;
}

function isIssueLocalContinuable(result: UnifiedLifecycleResult): boolean {
  return result.disposition === "no-change" || result.disposition === "repairable-failure" || result.disposition === "blocked" || result.disposition === "finalization-blocked";
}

function emitScheduler(
  reporter: LifecycleReporter | undefined,
  options: LifecycleSchedulerOptions,
  entry: "auto" | "monitor",
  issueNumber: number,
  state: "start" | "ready" | "activity" | "heartbeat" | "pass" | "fail" | "blocked" | "skipped" | "completed",
  detail?: string,
): void {
  reporter?.({
    issueNumber,
    phase: issueNumber > 0 && detail?.startsWith("claim") ? "claim" : "scheduler",
    state,
    detail,
    runId: options.runId,
    entry,
    projection: {
      activeIssue: issueNumber > 0 ? issueNumber : undefined,
      runId: options.runId,
      phase: issueNumber > 0 && detail?.startsWith("claim") ? "claim" : "scheduler",
      workerLive: false,
    },
  });
}

/**
 * Queue-level scheduler over the canonical single-issue lifecycle.  It owns
 * only selection, per-issue invocation, authority re-query and budget/yield
 * policy; it intentionally contains no worker, repair, verification,
 * recovery or finalization state machine.
 */
function cancelled(
  options: LifecycleSchedulerOptions,
  entry: "auto" | "monitor",
  results: UnifiedLifecycleResult[],
  latest?: UnifiedLifecycleResult,
): LifecycleSchedulerResult {
  emitScheduler(options.reporter, options, entry, 0, "completed", "cancelled by operator");
  return { runId: options.runId, entry, settled: results.length, results, disposition: "cancelled", latest: latest ?? results.at(-1) };
}

export async function runLifecycleScheduler(
  options: LifecycleSchedulerOptions,
  dependencies: SingleIssueLifecycleDependencies = {},
  execute?: IssueLifecycleExecutor,
): Promise<LifecycleSchedulerResult> {
  const entry = options.entry ?? "auto";
  const results: UnifiedLifecycleResult[] = [];
  const maxIssues = Math.max(0, Math.trunc(options.policy.maxIssues));
  while (results.length < maxIssues) {
    // Before selection: never discover a fresh candidate once a stop has
    // already been requested (issue #165).
    if (options.signal?.aborted) return cancelled(options, entry, results);
    emitScheduler(options.reporter, options, entry, 0, "start", "selecting work");
    const selection = await options.discover(results);
    if (!selection) {
      emitScheduler(options.reporter, options, entry, 0, results.length === 0 ? "skipped" : "completed", results.length === 0 ? "no eligible issues" : "candidate queue exhausted");
      return { runId: options.runId, entry, settled: results.length, results, disposition: results.length === 0 ? "idle" : "completed", latest: results.at(-1) };
    }
    emitScheduler(options.reporter, options, entry, selection.issueNumber, "ready", `selected #${selection.issueNumber}`);
    // Before claim: a selection made just before abort must not go on to
    // claim ownership of an issue this run is no longer going to work.
    if (options.signal?.aborted) return cancelled(options, entry, results);
    let claim: LifecycleSchedulerClaimHandle | undefined;
    if (options.claim) {
      emitScheduler(options.reporter, options, entry, selection.issueNumber, "start", `claim #${selection.issueNumber}`);
      try {
        claim = await options.claim(selection);
        emitScheduler(options.reporter, options, entry, selection.issueNumber, "pass", `claim #${selection.issueNumber}`);
      } catch (error) {
        if (error instanceof LifecycleSchedulerClaimConflict) {
          // Another owner won the race after selection. This is a
          // scheduler-local candidate skip: no result is recorded and no
          // issue mutation happened, so the run continues by requerying.
          emitScheduler(options.reporter, options, entry, selection.issueNumber, "skipped", `claim conflict #${selection.issueNumber}`);
          options.onClaimConflict?.(selection, error);
          continue;
        }
        emitScheduler(options.reporter, options, entry, selection.issueNumber, "fail", `claim #${selection.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    let result: UnifiedLifecycleResult;
    try {
      // After claim: cancellation may arrive while an asynchronous CAS claim
      // is in flight. In that case the scheduler owns a fresh lease, but the
      // stopped run must release it and exit before launching a worker or
      // entering the single-issue lifecycle.
      if (options.signal?.aborted) return cancelled(options, entry, results);
      result = await runSingleIssueLifecycle({
        ...options,
        entry,
        runId: `${options.runId}:issue-${selection.issueNumber}`,
        workItem: { issueNumber: selection.issueNumber },
        reporter: options.reporter,
      }, dependencies, execute);
    } finally {
      await claim?.release();
    }
    results.push(result);
    emitScheduler(options.reporter, options, entry, result.issueNumber, result.disposition === "pass" || result.disposition === "already-satisfied" ? "pass" : "blocked", `issue #${result.issueNumber} result ${result.disposition}`);
    emitScheduler(options.reporter, options, entry, 0, "activity", "re-querying authority");
    await options.requeryAuthority?.(result);
    if (result.disposition === "budget-yield") {
      emitScheduler(options.reporter, options, entry, 0, "completed", "budget yield");
      return { runId: options.runId, entry, settled: results.length, results, disposition: "budget-yield", latest: result };
    }
    if (result.disposition !== "pass" && result.disposition !== "already-satisfied") {
      if (!options.policy.continueAfterIssueLocalFailure || !isIssueLocalContinuable(result)) {
        emitScheduler(options.reporter, options, entry, 0, "blocked", `blocked after #${result.issueNumber}`);
        return { runId: options.runId, entry, settled: results.length, results, disposition: "blocked", latest: result };
      }
      emitScheduler(options.reporter, options, entry, 0, "activity", "continuing to next issue");
    }
    // Between issue iterations: an abort that fired while this issue's
    // lifecycle was in flight (the signal is also threaded through to the
    // worker boundary inside runSingleIssueLifecycle/kernel.ts) must stop the
    // run here rather than discovering and claiming another issue.
    if (options.signal?.aborted) return cancelled(options, entry, results, result);
  }
  emitScheduler(options.reporter, options, entry, 0, "completed", "requested issue budget reached");
  return { runId: options.runId, entry, settled: results.length, results, disposition: "budget-yield", latest: results.at(-1) };
}

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
    const selection = await options.discover(results);
    if (!selection) {
      return { runId: options.runId, entry, settled: results.length, results, disposition: results.length === 0 ? "idle" : "completed", latest: results.at(-1) };
    }
    // Before claim: a selection made just before abort must not go on to
    // claim ownership of an issue this run is no longer going to work.
    if (options.signal?.aborted) return cancelled(options, entry, results);
    let claim: LifecycleSchedulerClaimHandle | undefined;
    if (options.claim) {
      try {
        claim = await options.claim(selection);
      } catch (error) {
        if (error instanceof LifecycleSchedulerClaimConflict) {
          // Another owner won the race after selection. This is a
          // scheduler-local candidate skip: no result is recorded and no
          // issue mutation happened, so the run continues by requerying.
          options.onClaimConflict?.(selection, error);
          continue;
        }
        throw error;
      }
    }
    let result: UnifiedLifecycleResult;
    try {
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
    await options.requeryAuthority?.(result);
    if (result.disposition !== "pass" && result.disposition !== "already-satisfied") {
      if (!options.policy.continueAfterIssueLocalFailure || !isIssueLocalContinuable(result)) {
        return { runId: options.runId, entry, settled: results.length, results, disposition: "blocked", latest: result };
      }
    }
    // Between issue iterations: an abort that fired while this issue's
    // lifecycle was in flight (the signal is also threaded through to the
    // worker boundary inside runSingleIssueLifecycle/kernel.ts) must stop the
    // run here rather than discovering and claiming another issue.
    if (options.signal?.aborted) return cancelled(options, entry, results, result);
  }
  return { runId: options.runId, entry, settled: results.length, results, disposition: "budget-yield", latest: results.at(-1) };
}

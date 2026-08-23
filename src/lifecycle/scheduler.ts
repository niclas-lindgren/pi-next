import { type IssueLifecycleExecutor, type LifecycleEntryPoint, type LifecycleReporter, runSingleIssueLifecycle, type SingleIssueLifecycleDependencies, type SingleIssueLifecycleOptions, type UnifiedLifecycleResult } from "./kernel.js";

export interface LifecycleSchedulerSelection {
  issueNumber: number;
}

export interface LifecycleSchedulerPolicy {
  maxIssues: number;
  continueAfterIssueLocalFailure?: boolean;
}

export interface LifecycleSchedulerOptions extends Omit<SingleIssueLifecycleOptions, "workItem" | "entry" | "runId"> {
  entry?: Extract<LifecycleEntryPoint, "auto" | "monitor">;
  runId: string;
  policy: LifecycleSchedulerPolicy;
  discover: (completed: readonly UnifiedLifecycleResult[]) => Promise<LifecycleSchedulerSelection | undefined>;
  requeryAuthority?: (result: UnifiedLifecycleResult) => Promise<void>;
  reporter?: LifecycleReporter;
}

export interface LifecycleSchedulerResult {
  runId: string;
  entry: "auto" | "monitor";
  settled: number;
  results: UnifiedLifecycleResult[];
  disposition: "idle" | "completed" | "budget-yield" | "blocked";
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
export async function runLifecycleScheduler(
  options: LifecycleSchedulerOptions,
  dependencies: SingleIssueLifecycleDependencies = {},
  execute?: IssueLifecycleExecutor,
): Promise<LifecycleSchedulerResult> {
  const entry = options.entry ?? "auto";
  const results: UnifiedLifecycleResult[] = [];
  const maxIssues = Math.max(0, Math.trunc(options.policy.maxIssues));
  while (results.length < maxIssues) {
    const selection = await options.discover(results);
    if (!selection) {
      return { runId: options.runId, entry, settled: results.length, results, disposition: results.length === 0 ? "idle" : "completed", latest: results.at(-1) };
    }
    const result = await runSingleIssueLifecycle({
      ...options,
      entry,
      runId: `${options.runId}:issue-${selection.issueNumber}`,
      workItem: { issueNumber: selection.issueNumber },
      reporter: options.reporter,
    }, dependencies, execute);
    results.push(result);
    await options.requeryAuthority?.(result);
    if (result.disposition !== "pass" && result.disposition !== "already-satisfied") {
      if (!options.policy.continueAfterIssueLocalFailure || !isIssueLocalContinuable(result)) {
        return { runId: options.runId, entry, settled: results.length, results, disposition: "blocked", latest: result };
      }
    }
  }
  return { runId: options.runId, entry, settled: results.length, results, disposition: "budget-yield", latest: results.at(-1) };
}

import { existsSync, readFileSync } from "node:fs";

import { loopNow, loopStateFile, markIssueDisposition, type LoopState } from "./loop-state.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { writeJsonAtomic } from "./util.ts";

export function recordSchedulerSkipState(
  cwd: string,
  runId: string,
  issueNumber: number,
  skips: NonNullable<LoopState["schedulerSkips"]>,
): void {
  const statePath = loopStateFile(cwd, runId);
  const skippedAt = loopNow();
  const reason = `Issue #${issueNumber} skipped: leased elsewhere (fresh_owner)`;
  const nextSkips = [
    ...skips.filter((item) => item.issueNumber !== issueNumber),
    { issueNumber, reasonCode: "fresh_owner" as const, reason, skippedAt },
  ].slice(-100);
  skips.splice(0, skips.length, ...nextSkips);
  if (!existsSync(statePath)) return;
  const current = JSON.parse(readFileSync(statePath, "utf8")) as LoopState;
  writeJsonAtomic(statePath, {
    ...current,
    schedulerSkips: nextSkips,
    issueMetrics: markIssueDisposition(current.issueMetrics, issueNumber, "leased_elsewhere", reason),
    lastOutcome: "yield_issue",
    lastReason: reason,
    updatedAt: skippedAt,
  });
}

export function recordFreshOwnerSchedulerSkip(
  cwd: string,
  runId: string,
  issueNumber: number,
  skips: NonNullable<LoopState["schedulerSkips"]>,
): void {
  recordSchedulerSkipState(cwd, runId, issueNumber, skips);
  recordLifecycleEvent(cwd, { event: "scheduler_skip", issueNumber, runId, outcome: "skip", reasonCode: "fresh_owner" });
}

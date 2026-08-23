import { CandidateState, Issue, WorkerReport } from "./types.js";

export const DEFAULT_ZERO_DELTA_IMPLEMENTATION_RETRY_BUDGET = 1;

export interface ZeroDeltaRetryDecisionInput {
  worker?: WorkerReport;
  candidate: CandidateState;
  issue: Issue;
  retryBudgetUsed: number;
  retryBudget: number;
  satisfactionProven: boolean;
  implementationWorkerLaunched: boolean;
  repairOrFinalizationStarted: boolean;
  workspaceSafe: boolean;
  cancellationRequested?: boolean;
}

export interface ZeroDeltaRetryDecision {
  eligible: boolean;
  reason: string;
  budgetExhausted: boolean;
}

export function candidateHasDelta(candidate: CandidateState): boolean {
  return candidate.changedFiles.length > 0 || candidate.committedChanges || candidate.uncommittedChanges;
}

export function decideZeroDeltaImplementationRetry(input: ZeroDeltaRetryDecisionInput): ZeroDeltaRetryDecision {
  if (input.retryBudgetUsed >= input.retryBudget) return { eligible: false, reason: "implementation retry budget exhausted", budgetExhausted: true };
  if (!input.implementationWorkerLaunched || !input.worker) return { eligible: false, reason: "no usable implementation worker was launched", budgetExhausted: false };
  if (input.worker.disposition !== "completed") return { eligible: false, reason: `implementation worker disposition was ${input.worker.disposition}`, budgetExhausted: false };
  if (candidateHasDelta(input.candidate)) return { eligible: false, reason: "candidate delta exists", budgetExhausted: false };
  if (input.issue.state === "CLOSED") return { eligible: false, reason: "authoritative issue is closed", budgetExhausted: false };
  if (input.satisfactionProven) return { eligible: false, reason: "satisfaction mechanically proven", budgetExhausted: false };
  if (!input.workspaceSafe) return { eligible: false, reason: "workspace/ownership state is not safe", budgetExhausted: false };
  if (input.repairOrFinalizationStarted) return { eligible: false, reason: "repair or finalization phase has already started", budgetExhausted: false };
  if (input.cancellationRequested) return { eligible: false, reason: "worker lifecycle cancellation requested", budgetExhausted: false };
  return {
    eligible: true,
    budgetExhausted: false,
    reason: "completed implementation produced zero candidate delta; issue remains open and satisfaction was not mechanically proven",
  };
}

export function zeroDeltaRetryEvidence(input: { previous: WorkerReport; candidate: CandidateState; issue: Issue; reason: string }): string {
  const candidate = input.candidate;
  return [
    "Previous implementation attempt returned completed but produced zero candidate changes.",
    "The issue remains open and satisfaction was not mechanically proven.",
    "Implement the issue; do not merely inspect/report completion.",
    "",
    `retry eligibility: ${input.reason}`,
    `prior disposition: ${input.previous.disposition}`,
    `prior role: ${input.previous.role}`,
    `issue state: ${input.issue.state ?? "OPEN"}`,
    `zero-delta proof: changedFiles=${candidate.changedFiles.length}; committedChanges=${candidate.committedChanges}; uncommittedChanges=${candidate.uncommittedChanges}; committedFiles=${candidate.committedFiles.length}; stagedFiles=${candidate.stagedFiles.length}; unstagedFiles=${candidate.unstagedFiles.length}; untrackedFiles=${candidate.untrackedFiles.length}`,
    `baselineRevision: ${candidate.baselineRevision}`,
    `headRevision: ${candidate.headRevision}`,
  ].join("\n");
}

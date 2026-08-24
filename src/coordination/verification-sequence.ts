/**
 * The mechanical-then-criterion verification sequence from #146's design
 * doc (docs/LIFECYCLE_KERNEL_UNIFICATION_DESIGN.md, §2b): mechanical checks
 * (bootstrap's `runChecks`/`CHECKS`, production's `pi_next_check` "quality"
 * action) always run first and are mandatory; criterion-evidence review
 * (production's acceptance-verification.ts classifier) is an optional
 * second stage, run only when the issue has criteria requiring it.
 *
 * Kept dependency-free like lifecycle-disposition.ts (string literals, no
 * imports from src/bootstrap or extensions/pi-next) so both sides can call
 * this without either importing the other. Callers compute their own
 * mechanical CheckReport[]/criterion evidence and pass in the reduced shape
 * below; this module only sequences the two stages into one
 * LifecycleDispositionResult.
 */
import {
  lifecycleDispositionFromBootstrap,
  lifecycleDispositionFromVerificationFailure,
  type LifecycleDispositionResult,
  type VerificationFailureDispositionValue,
} from "./lifecycle-disposition.ts";

export interface MechanicalCheckResult {
  command: string;
  passed: boolean;
}

/**
 * The outcome of production's criterion-evidence stage, already reduced to
 * a single status by the caller (mirrors extensions/pi-next/tools-check.ts's
 * existing `status = failed ? "FAIL" : unresolved ? "NEEDS_REVIEW" : "PASS"`
 * computation and its `aggregateVerificationFailureDisposition` call - this
 * module does not reimplement that aggregation, it only consumes the result).
 */
export type CriterionStageResult =
  | { status: "PASS" }
  | { status: "FAIL"; failureDisposition?: VerificationFailureDispositionValue }
  | { status: "NEEDS_REVIEW"; unresolvedCriteria: readonly string[] };

export interface VerificationSequenceInput {
  mechanicalChecks: readonly MechanicalCheckResult[];
  /** Evidence string for the failing check(s), used as the repairable-failure reason. */
  mechanicalFailureEvidence?: string;
  /** Omit when the issue has no criteria requiring evidence review (bootstrap today). */
  criterionStage?: CriterionStageResult;
}

export type VerificationSequenceResult =
  | { kind: "resolved"; mechanicalPass: boolean; lifecycleDisposition: LifecycleDispositionResult }
  | { kind: "needs-review"; mechanicalPass: true; unresolvedCriteria: readonly string[] };

/**
 * `NEEDS_REVIEW` (criterion evidence present but EXTERNAL/UNPROVEN, with no
 * criterion FAIL) has no corresponding LifecycleDisposition member today -
 * it is not a failure and not a foreign-owner/stale-lease "blocked". Rather
 * than guess a mapping, this returns a distinct "needs-review" result kind
 * so callers keep surfacing it exactly as they do today (production writes
 * it to VERIFY.md) until that gap gets an explicit design answer.
 */
export function runVerificationSequence(input: VerificationSequenceInput): VerificationSequenceResult {
  const mechanicalPass = input.mechanicalChecks.length > 0 && input.mechanicalChecks.every((check) => check.passed);
  if (!mechanicalPass) {
    return {
      kind: "resolved",
      mechanicalPass: false,
      lifecycleDisposition: lifecycleDispositionFromBootstrap("repairable-failure", input.mechanicalFailureEvidence),
    };
  }
  const criterionStage = input.criterionStage;
  if (!criterionStage || criterionStage.status === "PASS") {
    return { kind: "resolved", mechanicalPass: true, lifecycleDisposition: lifecycleDispositionFromBootstrap("pass") };
  }
  if (criterionStage.status === "FAIL") {
    return {
      kind: "resolved",
      mechanicalPass: true,
      lifecycleDisposition: lifecycleDispositionFromVerificationFailure(criterionStage.failureDisposition ?? "REPAIR"),
    };
  }
  return { kind: "needs-review", mechanicalPass: true, unresolvedCriteria: criterionStage.unresolvedCriteria };
}

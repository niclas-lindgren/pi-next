/**
 * One outer disposition every lifecycle entry point (bootstrap, production
 * controller, checkpoint promotion) can produce, so worker/controller/footer
 * state (#146) can be compared without each side owning its own vocabulary.
 *
 * This does not replace bootstrap's `Disposition` (src/bootstrap/types.ts),
 * production's `VerificationFailureDisposition`
 * (extensions/pi-next/verification-failure-disposition.ts), or
 * `WorkerFailureClassification` (extensions/pi-next/worker-failure.ts) -
 * those remain the specific, well-factored classifiers they already are.
 * This is the shared landing type they all translate into. Kept
 * dependency-free (string literals only, not imported types) so coordination
 * stays the neutral kernel both `src/bootstrap` and `extensions/pi-next` can
 * import from without either importing the other.
 */
export type LifecycleDisposition =
  | "pass"
  | "already-satisfied"
  | "no-change"
  | "repairable-failure"
  | "semantic-repair"
  | "defer-issue"
  | "reconcile"
  | "worker-failed"
  | "blocked";

/** Mirrors extensions/pi-next/verification-failure-disposition.ts's VerificationFailureDisposition. */
export type VerificationFailureDispositionValue = "REPAIR" | "DEFER_ISSUE" | "RECONCILE";

/** Mirrors extensions/pi-next/worker-failure.ts's WorkerFailureClassification. */
export type WorkerFailureClassificationValue = "runtime" | "repository" | "work" | "external" | "transient";

/** Mirrors src/bootstrap/types.ts's Disposition (the subset this outer type maps 1:1). */
export type BootstrapDispositionValue = "pass" | "already-satisfied" | "no-change" | "repairable-failure" | "blocked";

export interface LifecycleDispositionResult {
  disposition: LifecycleDisposition;
  /** Present only when disposition is semantic-repair, defer-issue, or reconcile. */
  verificationFailureDisposition?: VerificationFailureDispositionValue;
  /** Present only when disposition is worker-failed. */
  workerFailureCategory?: WorkerFailureClassificationValue;
  reason?: string;
}

export function lifecycleDispositionFromBootstrap(disposition: BootstrapDispositionValue, reason?: string): LifecycleDispositionResult {
  return { disposition, reason };
}

const VERIFICATION_FAILURE_MAP: Record<VerificationFailureDispositionValue, LifecycleDisposition> = {
  REPAIR: "semantic-repair",
  DEFER_ISSUE: "defer-issue",
  RECONCILE: "reconcile",
};

export function lifecycleDispositionFromVerificationFailure(
  verificationFailureDisposition: VerificationFailureDispositionValue,
  reason?: string,
): LifecycleDispositionResult {
  return { disposition: VERIFICATION_FAILURE_MAP[verificationFailureDisposition], verificationFailureDisposition, reason };
}

export function lifecycleDispositionFromWorkerFailure(
  workerFailureCategory: WorkerFailureClassificationValue,
  reason?: string,
): LifecycleDispositionResult {
  return { disposition: "worker-failed", workerFailureCategory, reason };
}

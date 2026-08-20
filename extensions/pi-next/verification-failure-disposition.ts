export type VerificationFailureDispositionInput =
  | "repair"
  | "defer_issue"
  | "reconcile";

export type VerificationFailureDisposition =
  | "REPAIR"
  | "DEFER_ISSUE"
  | "RECONCILE";

export interface FailureDispositionReview {
  criterion: string;
  verdict: "pass" | "fail" | "external";
  failureDisposition?: VerificationFailureDispositionInput;
  authority?: string;
}

const MIN_AUTHORITY_LENGTH = 20;

function compact(value: string | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ");
}

function looksLikeAuthorityReference(value: string): boolean {
  return /(?:#\d+|github|issue|comment|decision|dependency|sequenc|owner)/i.test(
    value,
  );
}

export function validateFailureDispositionReviews(
  reviews: readonly FailureDispositionReview[],
): string[] {
  const errors: string[] = [];

  for (const review of reviews) {
    const disposition = review.failureDisposition;
    const authority = compact(review.authority);

    if (review.verdict !== "fail") {
      if (disposition) {
        errors.push(
          `Failure disposition is only valid for FAIL reviews: ${review.criterion}`,
        );
      }
      if (authority) {
        errors.push(
          `Authority routing evidence is only valid for FAIL reviews: ${review.criterion}`,
        );
      }
      continue;
    }

    if (!disposition && authority) {
      errors.push(
        `FAIL review supplies authority without a failure disposition: ${review.criterion}`,
      );
      continue;
    }

    if (disposition === "defer_issue" || disposition === "reconcile") {
      if (
        authority.length < MIN_AUTHORITY_LENGTH ||
        !looksLikeAuthorityReference(authority)
      ) {
        errors.push(
          `${disposition} requires a concrete authoritative GitHub issue/comment/decision reference: ${review.criterion}`,
        );
      }
    }
  }

  return errors;
}

export function reviewFailureDisposition(
  review: FailureDispositionReview | undefined,
): VerificationFailureDisposition {
  if (!review || review.verdict !== "fail") return "REPAIR";
  if (review.failureDisposition === "defer_issue") return "DEFER_ISSUE";
  if (review.failureDisposition === "reconcile") return "RECONCILE";
  return "REPAIR";
}

/**
 * Route a semantic FAIL without ever converting it into semantic success.
 * Reconciliation wins because changed/contradictory authority must be resolved
 * before deciding which implementation is correct. A real repair wins over a
 * deferral so current-slice defects cannot be hidden behind deferred remainder.
 * Only an all-deferred failure set routes to DEFER_ISSUE.
 */
export function aggregateVerificationFailureDisposition(
  dispositions: readonly VerificationFailureDisposition[],
): VerificationFailureDisposition | undefined {
  if (!dispositions.length) return undefined;
  if (dispositions.includes("RECONCILE")) return "RECONCILE";
  if (dispositions.includes("REPAIR")) return "REPAIR";
  return "DEFER_ISSUE";
}

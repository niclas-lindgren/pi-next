import type { AcceptanceCriterion } from "./plan.ts";

export const ACCEPTANCE_EVIDENCE_POLICY = "structured-v1";

export type ManualAcceptanceReviewVerdict = "pass" | "fail" | "external";
export type AcceptanceEvidenceVerdict = "PASS" | "FAIL" | "EXTERNAL" | "UNPROVEN";
export type AcceptanceEvidenceScope = "local" | "composed/system-level";

export interface ManualAcceptanceReview {
  criterion: string;
  verdict: ManualAcceptanceReviewVerdict;
  evidence: string;
  scope?: AcceptanceEvidenceScope;
}

const BROAD_CRITERION_PATTERN =
  /\b(?:architecture|architectural|composed|cross[- ]component|every|all|whole|system[- ]level|topology|workflow|state[- ]machine|migration|authorization|security)\b/i;

export function requiresComposedEvidence(criterion: string): boolean {
  return BROAD_CRITERION_PATTERN.test(criterion);
}

export interface AcceptanceEvidenceResult {
  verdict: AcceptanceEvidenceVerdict;
  evidence: string;
}

const MIN_CONCRETE_EVIDENCE_LENGTH = 20;
const EXTERNAL_DECISION_VERB =
  "(?:confirm(?:s|ed)?|validat(?:e|es|ed)|approv(?:e|es|ed)|sign(?:s|ed)?[- ]?off)";
const EXTERNAL_GATE_PATTERNS = [
  /\b(?:legal|tax|payment|stripe)\s+(?:counsel|review|sign[- ]?off|approval)\b/i,
  /\bqualified\s+(?:reviewer|review|counsel|sign[- ]?off|approval)\b/i,
  new RegExp(
    `\\b(?:provider|stripe)\\s+(?:support|account\\s+team).{0,80}\\b${EXTERNAL_DECISION_VERB}\\b`,
    "i",
  ),
  new RegExp(
    `\\b${EXTERNAL_DECISION_VERB}\\b.{0,80}\\b(?:provider|stripe)\\s+(?:support|account\\s+team)\\b`,
    "i",
  ),
  /\b(?:human|product|design)\s+(?:approval|sign[- ]?off)\b/i,
  /\b(?:approved|validated|confirmed|verified)\b.{0,60}\bby a human\b/i,
];

// These terms describe the evidence policy itself rather than making the
// named actor/environment part of the current criterion's required outcome.
// Keep this role check separate from the gate patterns so new external actors
// do not require a growing list of phrase-specific exclusions.
const ACTUAL_OUTCOME_POLICY_PATTERN =
  /\bactual(?:\s+(?:external|genuine|real))?\s+required(?:\s+(?:external|genuine|real))?\s+outcome\b[\s\S]*?\bremain(?:s|ed)? impossible to self[- ]certif(?:y|ied)\b/i;
// Keep the final entrypoint's canonical policy shape independently explicit.
// This prevents a stale/broader external-gate matcher at that boundary from
// reclassifying the assertion merely because its examples name real gates.
const CANONICAL_ACTUAL_OUTCOME_POLICY_PATTERN =
  /\b(?:a|the)\s+criterion\b[\s\S]*?\bactual\s+required\s+outcome\b[\s\S]*?\bremain(?:s|ed)? impossible to self[- ]certif(?:y|ied)\b/i;

const META_EXTERNAL_WORDING_PATTERNS = [
  /\b(?:regression[- ]coverage\b|(?:regression|unit|integration|acceptance)\s+(?:test|tests|coverage))\b/i,
  /\b(?:test|tests|testing|fixture|fixtures|documentation|docs|example|examples)\b.{0,100}\b(?:cover|covers|prove|proves|describe|describes|compare|compares|contrast|distinguish|distinguishes|cannot substitute|must not accept)\b/i,
  /\b(?:cover|covers|prove|proves|describe|describes|compare|compares|contrast|distinguish|distinguishes)\b.{0,100}\b(?:test|tests|testing|fixture|fixtures|documentation|docs|example|examples)\b/i,
  /\b(?:vs\.?|versus)\b/i,
  /\b(?:quoted|embedded|mentioned)\b/i,
  // Meta criteria can describe the required external outcome of another
  // criterion. The subject is the verifier rule, not the actor/environment
  // evidence itself, so this must be recognized before gate matching.
  /\b(?:a|the)\s+criterion\b.{0,140}\b(?:actual\s+)?required\s+outcome\b.{0,180}\b(?:remain(?:s|ed)?\s+impossible|cannot\s+self[- ]certif(?:y|ied)|must\s+remain\s+impossible)\b/i,
  // Keep the canonical provenance-preservation acceptance shape explicit at
  // the final-verification boundary; parser punctuation or inserted wording
  // must not turn this policy assertion into a direct external gate.
  ACTUAL_OUTCOME_POLICY_PATTERN,
  // A provenance-policy criterion can state the unresolved outcome that
  // missing evidence must produce; the assertion itself is locally testable.
  /\b(?:missing|absent|without)\b[\s\S]{0,120}\bprovenance\b[\s\S]{0,180}\b(?:yield|never become|does not become|remain(?:s|ed)?)\b[\s\S]{0,100}\b(?:external|unproven|pass)\b/i,
  // The same repository-verifiable policy can name the required sources
  // directly instead of using the word provenance.
  /\bmissing\b[\s\S]{0,100}\brequired\b[\s\S]{0,100}\bevidence\b[\s\S]{0,80}\b(?:produces?|yields?|remains?|cannot)\b[\s\S]{0,50}\b(?:unproven|pass)\b/i,
  // A criterion can explicitly assert that embedded external wording must not
  // promote the outer criterion. That negative assertion is repository-
  // verifiable meta evidence, not an external gate itself.
  /\b(?:not|never|cannot|must not|does not)\b.{0,100}\b(?:classif(?:y|ied)|promot(?:e|ed)|treat(?:s|ed)?)\b.{0,60}\bexternal\b/i,
];

function normalizeCriterionRole(text: string): string {
  // The final-verification entrypoint can receive either PLAN lines or raw
  // GitHub Markdown. Normalize both forms before applying role-aware policy so
  // parser formatting cannot bypass the shared meta/regression guard.
  return text
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/[`*_]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetaExternalCriterion(text: string): boolean {
  return META_EXTERNAL_WORDING_PATTERNS.some((pattern) =>
    pattern.test(normalizeCriterionRole(text)),
  );
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const PROVENANCE_REQUIREMENTS = [
  { criterion: /\b(?:owner|customer|campsite) evidence\b/i, evidence: /\b(?:owner|customer|campsite)\b.{0,80}\b(?:interview|response|feedback|confirmation|evidence|approval)\b/i, label: "required owner/customer evidence" },
  { criterion: /\bproduction\b/i, evidence: /\bproduction\b.{0,80}\b(?:tested|test|smoke|run|verified|evidence|deployed|observed|passed)\b/i, label: "production evidence" },
  { criterion: /\bprovider sandbox\b/i, evidence: /\bprovider sandbox\b.{0,80}\b(?:tested|test|run|verified|evidence|confirmed|observed)\b/i, label: "provider-sandbox evidence" },
  { criterion: /\breal (?:runs?|users?|customers?|data)\b/i, evidence: /\breal (?:runs?|users?|customers?|data)\b/i, label: "real-world evidence" },
];
const NEGATED_PROVENANCE = /(?:\b(?:not|no|without|hasn't|haven't|missing|absent|pending|unavailable|awaiting|to be collected|will collect|planned|hypothetical|simulated|synthetic|documentation only)\b.{0,80}\b(?:evidence|approval|confirmation|sandbox|production|owner|customer|human|real)\b|\b(?:evidence|approval|confirmation|sandbox|production|owner|customer|human|real)\b.{0,80}\b(?:not|no|without|missing|absent|pending|unavailable|awaiting|to be collected|planned|hypothetical|simulated)\b)/i;

function authorityText(value: string): string {
  return compact(value.replace(/^external:\s*/i, ""));
}

export function isMechanicalAcceptanceCriterion(text: string): boolean {
  return text.startsWith("run:") || text.startsWith("grep:") || text.startsWith("commit:");
}

const COMMIT_SHA_PATTERN = /\bcommit:([0-9a-f]{7,40})\b/gi;

/**
 * Extract every distinct `commit:<sha>` evidence SHA cited anywhere in a
 * VERIFY.md report (criterion column, evidence prose, or log entries). This
 * is deliberately a pure text scan so callers can validate the returned SHAs
 * against git reachability without re-parsing the report structure.
 */
export function extractCommitEvidenceShas(report: string): string[] {
  const shas = new Set<string>();
  for (const match of report.matchAll(COMMIT_SHA_PATTERN)) {
    shas.add(match[1].toLowerCase());
  }
  return [...shas];
}

export function isExternalAcceptanceCriterion(text: string): boolean {
  const raw = text.trim();
  // Explicit external: remains authoritative, even if its explanation uses
  // meta wording. All ordinary criteria must resolve their role first so
  // embedded external terms cannot win by phrase-match ordering.
  if (/^external:/i.test(raw)) return true;

  const normalized = normalizeCriterionRole(raw);
  if (isMetaExternalCriterion(normalized)) return false;
  return EXTERNAL_GATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The final-verification entry point shares the same role-aware classifier. */
export function isFinalVerificationExternalCriterion(text: string): boolean {
  // Keep the runtime boundary conservative for the authoritative regression-
  // coverage shape even if a caller supplies parser-formatted Markdown.
  // Explicit external: remains authoritative.
  if (/^external:/i.test(text.trim())) return true;
  const normalized = normalizeCriterionRole(text);
  // A policy criterion describing the actual outcome of another criterion is
  // itself repository-verifiable, even when its examples name external gates.
  // Keep this explicit at the final boundary so parser/authority formatting
  // cannot route it through the conservative external path.
  if (isMetaExternalCriterion(normalized)) return false;
  if (
    ACTUAL_OUTCOME_POLICY_PATTERN.test(normalized) ||
    CANONICAL_ACTUAL_OUTCOME_POLICY_PATTERN.test(normalized)
  ) return false;
  return isExternalAcceptanceCriterion(normalized);
}

/**
 * Return authoritative issue-body acceptance criteria that are absent or
 * reworded in PLAN.md. `external:` is a workflow annotation and is stripped
 * before exact comparison; other paraphrasing is deliberately rejected.
 */
export function missingAuthoritativeAcceptanceCriteria(
  authoritative: readonly string[],
  planCriteria: readonly AcceptanceCriterion[],
): string[] {
  const planned = new Set(
    planCriteria
      .filter((criterion) => !isMechanicalAcceptanceCriterion(criterion.text))
      .map((criterion) => authorityText(criterion.text)),
  );
  return authoritative.filter((criterion) => !planned.has(authorityText(criterion)));
}

export function validateManualAcceptanceReviews(
  criteria: readonly AcceptanceCriterion[],
  reviews: readonly ManualAcceptanceReview[],
  additionalExactCriteria: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  const validCriteria = new Set([
    ...criteria.map((criterion) => criterion.text),
    ...additionalExactCriteria,
  ]);
  const seen = new Set<string>();

  for (const review of reviews) {
    // Mechanical criteria are evaluated by the deterministic verifier below;
    // redundant model reviews must not turn that boundary into a validation
    // error or provide an alternate verdict.
    if (isMechanicalAcceptanceCriterion(review.criterion)) continue;

    if (!validCriteria.has(review.criterion)) {
      errors.push(`Review references unknown criterion: ${review.criterion}`);
      continue;
    }
    if (seen.has(review.criterion)) {
      errors.push(`Duplicate review for criterion: ${review.criterion}`);
      continue;
    }
    seen.add(review.criterion);

    if (isMechanicalAcceptanceCriterion(review.criterion)) {
      errors.push(
        `Mechanical criterion cannot be overridden by manual review: ${review.criterion}`,
      );
    }
  }

  return errors;
}

function isRepositoryVerifiablePolicyCriterion(text: string): boolean {
  const normalized = normalizeCriterionRole(text);
  return (
    isMetaExternalCriterion(normalized) ||
    ACTUAL_OUTCOME_POLICY_PATTERN.test(normalized)
  );
}

export function evaluateManualAcceptanceCriterion(
  criterion: AcceptanceCriterion,
  reviews: readonly ManualAcceptanceReview[],
): AcceptanceEvidenceResult {
  const check = criterion.text;
  const review = reviews.find((item) => item.criterion === check);

  // Explicit or high-confidence external gates are intentionally impossible
  // to self-certify. A model-supplied PASS review is ignored: only real
  // external evidence followed by an authoritative GitHub requirement update
  // can remove/change the gate.
  if (!isRepositoryVerifiablePolicyCriterion(check) && isExternalAcceptanceCriterion(check)) {
    return {
      verdict: "EXTERNAL",
      evidence: review?.evidence
        ? `external prerequisite remains unresolved; reviewer note: ${compact(review.evidence)}`
        : "external prerequisite remains unresolved; PLAN checkbox state cannot satisfy it",
    };
  }

  if (!review) {
    return {
      verdict: "UNPROVEN",
      evidence: criterion.checked
        ? "checked in PLAN.md, but checkbox state is workflow state and is not verification evidence"
        : "no structured verification evidence supplied",
    };
  }

  const evidence = compact(review.evidence);
  if (review.verdict === "fail") {
    return {
      verdict: "FAIL",
      evidence: evidence || "reviewer reported failure without evidence detail",
    };
  }
  if (review.verdict === "external") {
    return {
      verdict: "EXTERNAL",
      evidence: evidence || "reviewer identified an unresolved external prerequisite",
    };
  }

  if (
    evidence.length < MIN_CONCRETE_EVIDENCE_LENGTH ||
    /^(checked( in plan(?:\.md)?)?|done|implemented|verified|tests? pass(?:ed)?)\.?$/i.test(
      evidence,
    )
  ) {
    return {
      verdict: "UNPROVEN",
      evidence:
        "PASS review lacked concrete evidence; cite inspected implementation/test/runtime evidence, not completion state",
    };
  }

  const provenance = isMetaExternalCriterion(check)
    ? undefined
    : PROVENANCE_REQUIREMENTS.find((requirement) => requirement.criterion.test(check));
  if (provenance && (NEGATED_PROVENANCE.test(evidence) || !provenance.evidence.test(evidence))) {
    return {
      verdict: "UNPROVEN",
      evidence: `${provenance.label} is explicitly required, but the supplied evidence is missing, substituted, or negated`,
    };
  }

  if (requiresComposedEvidence(check) && review.scope !== "composed/system-level") {
    return {
      verdict: "UNPROVEN",
      evidence:
        "broad/system-level criterion requires scope=composed/system-level evidence; local evidence cannot prove the whole boundary",
    };
  }

  return {
    verdict: "PASS",
    evidence: `${review.scope ?? "local"} evidence: ${evidence}`,
  };
}

/**
 * Deterministic archive-time validation for a semantic VERIFY.md report.
 * This deliberately does not evaluate product semantics; it proves that the
 * report uses the current evidence policy, targets the expected issue, was
 * produced against live authority, contains no unresolved verdict, and still
 * matches the current issue/comments fingerprint supplied by the caller.
 */
export function verificationReportAuthorityErrors(
  report: string,
  expectedIssueNumber: number,
  liveIssueFingerprint: string,
): string[] {
  const errors: string[] = [];
  const evidencePolicy = report.match(/^EVIDENCE_POLICY:\s*(\S+)$/m)?.[1];
  if (evidencePolicy !== ACCEPTANCE_EVIDENCE_POLICY) {
    errors.push("legacy/self-attested verification evidence policy");
  }
  if (!/^AUTHORITY_STATUS:\s*VERIFIED$/m.test(report)) {
    errors.push("live GitHub issue authority was not verified");
  }
  const reportIssue = Number.parseInt(
    report.match(/^GITHUB_ISSUE:\s*#(\d+)$/m)?.[1] || "",
    10,
  );
  if (reportIssue !== expectedIssueNumber) {
    errors.push("verification evidence belongs to a different GitHub issue");
  }
  const reportFingerprint = report.match(
    /^ISSUE_FINGERPRINT:\s*(\S+)$/m,
  )?.[1];
  if (!reportFingerprint || reportFingerprint === "unverified") {
    errors.push("verification evidence is missing the live issue/comments fingerprint");
  } else if (reportFingerprint !== liveIssueFingerprint) {
    errors.push("live GitHub issue/comments changed after semantic verification");
  }
  if (/\|\s*(?:FAIL|EXTERNAL|UNPROVEN)\s*\|/.test(report)) {
    errors.push("verification contains failed, external, or unproven acceptance evidence");
  }
  return errors;
}

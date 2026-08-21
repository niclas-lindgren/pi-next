/**
 * Adapter-neutral primitives for pi-next's closed-loop self assessment.
 *
 * This module deliberately contains policy, not a model or a repository
 * layout.  It is safe to use from another harness and keeps the durable
 * records small enough to be persisted or sent to an authority adapter.
 */
import { createHash } from "node:crypto";
import { sanitizeFeedbackText } from "./feedback.ts";

export const SELF_ASSESSMENT_VERSION = 1 as const;
export const HEALTH_DIMENSIONS = [
  "progressEfficiency",
  "repetition",
  "contextPressure",
  "tokenEfficiency",
  "verificationChurn",
  "gitWorkflowChurn",
  "recoveryRate",
  "lifecycleIntegrity",
  "runtimeFailureRecurrence",
] as const;
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];

export interface HealthPolicy {
  noProgressThreshold: number;
  repeatedFailureThreshold: number;
  repeatedCommandThreshold: number;
  contextPressureThreshold: number;
  tokenAccelerationThreshold: number;
  maxMaintenanceOverheadShare: number;
}

export const DEFAULT_HEALTH_POLICY: Readonly<HealthPolicy> = Object.freeze({
  noProgressThreshold: 2,
  repeatedFailureThreshold: 2,
  repeatedCommandThreshold: 2,
  contextPressureThreshold: 0.85,
  tokenAccelerationThreshold: 2,
  maxMaintenanceOverheadShare: 0.2,
});

export interface HealthState {
  version: typeof SELF_ASSESSMENT_VERSION;
  runId?: string;
  issueNumber?: number;
  updatedAt: string;
  dimensions: Record<HealthDimension, number>;
  noProgressStreak: number;
  failureCounts: Record<string, number>;
  commandCounts: Record<string, number>;
  recoveryCount: number;
  recoveryKeys: string[];
  transitionCount: number;
  strategyChanges: number;
  lastFingerprint?: string;
}

export interface HealthObservation {
  runId?: string;
  issueNumber?: number;
  transitionType: string;
  headDiverged?: boolean;
  durableProgress?: boolean;
  failureFingerprint?: string;
  /** Multiple bounded inner-tool failures observed in one worker turn. */
  failureFingerprints?: readonly string[];
  /** Productive red-test/verification evidence excluded from runtime escalation. */
  expectedFailureFingerprints?: readonly string[];
  recoveredFailureFingerprints?: readonly string[];
  qualityFingerprint?: string;
  qualityOk?: boolean;
  qualityCommandFingerprints?: string[];
  promptCount?: number;
  freshTokens?: number;
  contextRatio?: number;
  workflowOnlyCommit?: boolean;
  lifecycleEvents?: readonly string[];
  recoveryEvents?: readonly string[];
  verificationFailRepairSameFingerprint?: boolean;
  baselineQualityRediscovered?: boolean;
  at?: string;
}

export interface HealthAssessment {
  state: HealthState;
  signals: string[];
  strategy: "none" | "change_strategy" | "escalate";
  fingerprint?: string;
  reason: string;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function emptyDimensions(): Record<HealthDimension, number> {
  return Object.fromEntries(HEALTH_DIMENSIONS.map((name) => [name, 0])) as Record<HealthDimension, number>;
}

export function emptyHealthState(now = new Date().toISOString()): HealthState {
  return {
    version: SELF_ASSESSMENT_VERSION,
    updatedAt: now,
    dimensions: emptyDimensions(),
    noProgressStreak: 0,
    failureCounts: {},
    commandCounts: {},
    recoveryCount: 0,
    recoveryKeys: [],
    transitionCount: 0,
    strategyChanges: 0,
  };
}

function increment(map: Record<string, number>, key: string | undefined): number {
  if (!key) return 0;
  map[key] = Math.min(999, (map[key] || 0) + 1);
  return map[key];
}

function stableFingerprint(observation: HealthObservation): string {
  const source = [
    observation.transitionType,
    observation.failureFingerprint || "",
    observation.qualityFingerprint || "",
    ...(observation.lifecycleEvents || []).slice(0, 6),
  ].join("|");
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

/** Evaluate one managed transition without invoking a model. */
export function evaluateHealth(
  previous: HealthState | undefined,
  observation: HealthObservation,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): HealthAssessment {
  const state: HealthState = {
    ...(previous || emptyHealthState()),
    version: SELF_ASSESSMENT_VERSION,
    runId: observation.runId || previous?.runId,
    issueNumber: observation.issueNumber || previous?.issueNumber,
    updatedAt: observation.at || new Date().toISOString(),
    dimensions: { ...emptyDimensions(), ...(previous?.dimensions || {}) },
    failureCounts: { ...(previous?.failureCounts || {}) },
    commandCounts: { ...(previous?.commandCounts || {}) },
  };
  state.transitionCount = Math.min(9999, state.transitionCount + 1);

  const signals: string[] = [];
  const noProgress = observation.durableProgress === false || observation.transitionType === "no_progress";
  state.noProgressStreak = noProgress ? state.noProgressStreak + 1 : 0;
  if (state.noProgressStreak >= policy.noProgressThreshold) signals.push(`no-progress streak ${state.noProgressStreak}`);

  const expectedFailures = new Set(observation.expectedFailureFingerprints || []);
  const failureFingerprints = (observation.failureFingerprints?.length
    ? observation.failureFingerprints
    : observation.failureFingerprint ? [observation.failureFingerprint] : [])
    .filter((fingerprint) => Boolean(fingerprint) && !expectedFailures.has(fingerprint));
  let failureCount = 0;
  for (const fingerprint of failureFingerprints) {
    failureCount = Math.max(failureCount, increment(state.failureCounts, fingerprint));
    const count = state.failureCounts[fingerprint];
    if (count >= policy.repeatedFailureThreshold) signals.push(`failure fingerprint repeated ${count} times`);
  }

  for (const command of (observation.qualityCommandFingerprints || []).slice(0, 12)) {
    const count = increment(state.commandCounts, command);
    if (count >= policy.repeatedCommandThreshold && observation.qualityOk) {
      signals.push(`reused passing quality command ${count} times`);
    }
  }

  const contextPressure = clamp(finite(observation.contextRatio));
  if (contextPressure >= policy.contextPressureThreshold) {
    signals.push(`context pressure ${(contextPressure * 100).toFixed(0)}%`);
  }
  if (finite(observation.freshTokens) > 0 && finite(observation.promptCount) > 0) {
    const density = observation.freshTokens! / observation.promptCount!;
    if (density >= 250_000) signals.push(`high fresh tokens per transition ${Math.round(density)}`);
  }

  const recoveryCandidates = [
    ...(observation.lifecycleEvents || []),
    ...(observation.recoveryEvents || []),
    ...(observation.recoveredFailureFingerprints || []).map((fingerprint) => `tool-recovery:${fingerprint}`),
  ].filter((event) => /repair|quarantin|recover|migrat|reconcil|tool-recovery/i.test(event));
  const previousRecoveryKeys = new Set(state.recoveryKeys || []);
  const recoveries = recoveryCandidates.filter((event) => !previousRecoveryKeys.has(event));
  state.recoveryKeys = [...new Set([...(state.recoveryKeys || []), ...recoveryCandidates])].slice(-100);
  state.recoveryCount = Math.min(9999, state.recoveryCount + recoveries.length);
  if (recoveries.length) signals.push(`recovery path used (${recoveries.length})`);
  if (observation.verificationFailRepairSameFingerprint) signals.push("verification failure-repair-same-fingerprint loop");
  if (observation.baselineQualityRediscovered) signals.push("baseline quality evidence rediscovered");
  if (observation.headDiverged) signals.push("unexpected inter-transition HEAD divergence");
  if (observation.workflowOnlyCommit) signals.push("workflow-only commit observed");

  const bad = new Set(signals);
  state.dimensions = {
    progressEfficiency: clamp(state.noProgressStreak / Math.max(1, policy.noProgressThreshold)),
    repetition: clamp(Math.max(failureCount / Math.max(1, policy.repeatedFailureThreshold), bad.has("reused passing quality command 2 times") ? 0.75 : 0)),
    contextPressure,
    tokenEfficiency: finite(observation.freshTokens) > 250_000 ? 1 : 0,
    verificationChurn: observation.verificationFailRepairSameFingerprint ? 1 : 0,
    gitWorkflowChurn: observation.workflowOnlyCommit || observation.headDiverged ? 0.75 : 0,
    recoveryRate: clamp(recoveries.length / 2),
    lifecycleIntegrity: observation.headDiverged ? 1 : 0,
    runtimeFailureRecurrence: clamp(failureCount / Math.max(1, policy.repeatedFailureThreshold)),
  };

  const severe = state.dimensions.lifecycleIntegrity >= 1 ||
    state.dimensions.repetition >= 1 ||
    state.dimensions.runtimeFailureRecurrence >= 1 ||
    state.recoveryCount >= policy.repeatedFailureThreshold;
  const strategy = severe ? "escalate" : signals.length ? "change_strategy" : "none";
  if (strategy !== "none") state.strategyChanges = Math.min(999, state.strategyChanges + 1);
  state.lastFingerprint = failureFingerprints[0] || observation.failureFingerprint || stableFingerprint(observation);
  return {
    state,
    signals: signals.slice(0, 12),
    strategy,
    fingerprint: state.lastFingerprint,
    reason: signals.length ? signals.join("; ") : "no deterministic health anomaly observed",
  };
}

export interface ComplexityMetrics {
  plannedTasks: number;
  acceptanceCriteria: number;
  changedFiles: number;
  sourceFiles: number;
  testFiles: number;
  docsFiles: number;
  migrationFiles: number;
  additions: number;
  deletions: number;
  verificationExecuted?: number;
  verificationReused?: number;
}

export interface IssueEfficiencyMetrics {
  freshTokens: number;
  costUsd: number;
  wallMs: number;
  complexity: ComplexityMetrics;
  risk?: string;
  phase?: string;
  model?: string;
}

export interface NormalizedIssueMetrics {
  freshTokensPerTask: number;
  freshTokensPerAcceptanceCriterion: number;
  freshTokensPerChangedFile: number;
  costPerTask: number;
  wallMsPerTask: number;
  verificationReuseRate: number;
  cohort: string;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Use workload proxies instead of raw token totals for boundary decisions. */
export function normalizeIssueMetrics(input: IssueEfficiencyMetrics): NormalizedIssueMetrics {
  const c = input.complexity;
  const reuseTotal = finite(c.verificationExecuted) + finite(c.verificationReused);
  const cohort = [
    c.plannedTasks <= 1 ? "small" : c.plannedTasks <= 4 ? "medium" : "large",
    c.changedFiles <= 2 ? "few-files" : c.changedFiles <= 8 ? "multi-file" : "broad",
    input.risk || "unknown",
    input.phase || "unknown",
  ].join(":");
  return {
    freshTokensPerTask: ratio(input.freshTokens, c.plannedTasks),
    freshTokensPerAcceptanceCriterion: ratio(input.freshTokens, c.acceptanceCriteria),
    freshTokensPerChangedFile: ratio(input.freshTokens, c.changedFiles),
    costPerTask: ratio(input.costUsd, c.plannedTasks),
    wallMsPerTask: ratio(input.wallMs, c.plannedTasks),
    verificationReuseRate: ratio(finite(c.verificationReused), reuseTotal),
    cohort,
  };
}

export function comparablePeerCohort(
  current: NormalizedIssueMetrics,
  peers: readonly NormalizedIssueMetrics[],
): readonly NormalizedIssueMetrics[] {
  const same = peers.filter((peer) => peer.cohort === current.cohort);
  return same.length >= 2 ? same : peers;
}

export interface IssueBoundaryAssessment {
  cohort: string;
  comparablePeers: number;
  regressions: string[];
  maintenanceOverheadExceeded: boolean;
}

/** Complexity-normalized issue-boundary decision used by maintenance policy. */
export function assessIssueBoundary(
  current: NormalizedIssueMetrics,
  peers: readonly NormalizedIssueMetrics[],
  maintenanceOverheadShare = 0,
  maxMaintenanceOverheadShare = DEFAULT_HEALTH_POLICY.maxMaintenanceOverheadShare,
): IssueBoundaryAssessment {
  const cohortPeers = comparablePeerCohort(current, peers);
  return {
    cohort: current.cohort,
    comparablePeers: cohortPeers.length,
    regressions: relativeRegression(current, cohortPeers),
    maintenanceOverheadExceeded: maintenanceOverheadShare > maxMaintenanceOverheadShare,
  };
}

export function relativeRegression(
  current: NormalizedIssueMetrics,
  peers: readonly NormalizedIssueMetrics[],
  multiplier = 2,
): string[] {
  const cohort = comparablePeerCohort(current, peers);
  if (cohort.length < 2) return [];
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };
  const checks: Array<[string, number, number]> = [
    ["fresh tokens/task", current.freshTokensPerTask, median(cohort.map((p) => p.freshTokensPerTask))],
    ["cost/task", current.costPerTask, median(cohort.map((p) => p.costPerTask))],
    ["wall/task", current.wallMsPerTask, median(cohort.map((p) => p.wallMsPerTask))],
  ];
  return checks.filter(([, value, baseline]) => baseline > 0 && value >= baseline * multiplier).map(([name, value, baseline]) => `${name} ${Math.round(value)} vs peer median ${Math.round(baseline)}`);
}

export type FindingCategory = "runtime" | "efficiency" | "integrity" | "architecture" | "quality" | "adapter";
export type FindingSeverity = "info" | "P3" | "P2" | "P1" | "P0";
export type FindingConfidence = "low" | "medium" | "high";
export type FindingApprovalState = "observing" | "pending_review" | "approved" | "rejected" | "superseded";

export interface SelfAssessmentFinding {
  fingerprint: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  evidence: string[];
  affectedRuns: string[];
  affectedIssues: number[];
  recurrence: number;
  proposedAction: string;
  approvalState: FindingApprovalState;
  updatedAt?: string;
  authorityId?: string;
  authorityUrl?: string;
}

const FINDING_LIMIT = 100;
function boundedStrings(values: readonly string[], max = 8): string[] {
  return [...new Set(values.map((value) => sanitizeFeedbackText(value).slice(0, 300)).filter(Boolean))].slice(0, max);
}

export function mergeSelfAssessmentFinding(
  findings: readonly SelfAssessmentFinding[],
  incoming: SelfAssessmentFinding,
): SelfAssessmentFinding[] {
  const existing = findings.find((finding) => finding.fingerprint === incoming.fingerprint);
  const merged: SelfAssessmentFinding = {
    ...(existing || incoming),
    ...incoming,
    evidence: boundedStrings([...(existing?.evidence || []), ...incoming.evidence]),
    affectedRuns: boundedStrings([...(existing?.affectedRuns || []), ...incoming.affectedRuns], 12),
    affectedIssues: [...new Set([...(existing?.affectedIssues || []), ...incoming.affectedIssues].filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 20),
    recurrence: Math.min(9999, Math.max(existing?.recurrence || 0, incoming.recurrence)),
    approvalState: existing?.approvalState === "approved" || existing?.approvalState === "rejected" || existing?.approvalState === "superseded"
      ? existing.approvalState
      : incoming.approvalState,
    updatedAt: incoming.updatedAt || new Date().toISOString(),
  };
  return [...findings.filter((finding) => finding.fingerprint !== incoming.fingerprint), merged].slice(-FINDING_LIMIT);
}

export function findingPublicationEligible(
  finding: SelfAssessmentFinding,
  options: { recurrenceThreshold?: number; minConfidence?: FindingConfidence } = {},
): boolean {
  const threshold = options.recurrenceThreshold ?? 3;
  const confidence = options.minConfidence || "high";
  const rank = { low: 0, medium: 1, high: 2 };
  return finding.approvalState === "pending_review" && finding.recurrence >= threshold && rank[finding.confidence] >= rank[confidence];
}

export interface AdaptationEvaluation {
  state: "pending" | "validated" | "regressed" | "inconclusive";
  rollback: boolean;
  reason: string;
}

export function evaluateAdaptation(
  baseline: readonly number[],
  observed: readonly number[],
  options: { reversible: boolean; regressionPercent?: number; improvementPercent?: number } = { reversible: false },
): AdaptationEvaluation {
  if (!baseline.length || !observed.length) return { state: "pending", rollback: false, reason: "insufficient post-change observations" };
  const avg = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const before = avg(baseline);
  const after = avg(observed);
  if (before <= 0) return { state: "inconclusive", rollback: false, reason: "baseline has no measurable value" };
  const change = ((after - before) / before) * 100;
  const regression = options.regressionPercent ?? 25;
  const improvement = options.improvementPercent ?? 10;
  if (change >= regression) return { state: "regressed", rollback: options.reversible, reason: `observed metric regressed ${change.toFixed(1)}%; ${options.reversible ? "reversible adaptation should be rolled back" : "create a held corrective finding"}` };
  if (change <= -improvement) return { state: "validated", rollback: false, reason: `observed metric improved ${Math.abs(change).toFixed(1)}%` };
  return { state: "inconclusive", rollback: false, reason: `observed metric changed ${change.toFixed(1)}%; continue observation without stacking tuning` };
}

export function findingFromHealth(
  assessment: HealthAssessment,
  input: { runId?: string; issueNumber?: number; category?: FindingCategory; proposedAction: string },
): SelfAssessmentFinding | undefined {
  if (assessment.strategy !== "escalate" || !assessment.fingerprint) return undefined;
  return {
    fingerprint: assessment.fingerprint,
    title: `Recurring pi-next health anomaly: ${assessment.signals[0] || "systemic failure"}`.slice(0, 180),
    category: input.category || "runtime",
    severity: assessment.state.dimensions.lifecycleIntegrity >= 1 ? "P1" : "P2",
    confidence: "high",
    evidence: assessment.signals,
    affectedRuns: input.runId ? [input.runId] : [],
    affectedIssues: input.issueNumber ? [input.issueNumber] : [],
    recurrence: 1,
    proposedAction: sanitizeFeedbackText(input.proposedAction).slice(0, 500),
    approvalState: "pending_review",
  };
}

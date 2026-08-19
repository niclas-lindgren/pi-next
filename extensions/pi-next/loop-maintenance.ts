import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  observedSessionModel,
  publishIssuePerformanceMetrics,
} from "./performance-publication.ts";
import { buildLoopMaintenancePrompt } from "./prompt.ts";
import {
  emptyLoopMetrics,
  loopNow,
  safeLoopBoundary,
  sessionUsage,
  usageDelta,
  type LoopIssueMetrics,
  type LoopState,
} from "./loop-state.ts";
import { removeFile, runtimeDir, writeJsonAtomic } from "./util.ts";
import { runIssueWorker, type IssueWorkerRunner } from "./util-core.ts";

const MAX_HISTORY = 20;
const PERIODIC_REVIEW_EVERY = 10;
const EVALUATE_AFTER_ISSUES = 3;
const MIN_RELATIVE_PEERS = 3;
const SEVERE_PROMPTS = 12;
const SEVERE_SESSIONS = 8;
const SEVERE_FRESH_TOKENS = 750_000;
const SEVERE_WALL_MS = 60 * 60_000;
const MIN_RELATIVE_FRESH_TOKENS = 250_000;
const MIN_RELATIVE_WALL_MS = 20 * 60_000;
const MIN_DENSE_PROMPT_TOKENS = 80_000;
const RELATIVE_MULTIPLIER = 2;
const MAX_TEXT = 800;
const MAX_ITEMS = 8;

export type MaintenanceAssessmentStatus =
  | "healthy_no_change"
  | "insufficient_evidence"
  | "change_applied"
  | "change_requires_reload"
  | "change_rejected_by_regression_guard"
  | "previous_tuning_rolled_back";

export interface MaintenanceAssessmentResult {
  status: MaintenanceAssessmentStatus;
  summary: string;
  rootCauses: string[];
  evidence: string[];
  confidence: "low" | "medium" | "high";
  action: {
    changed: boolean;
    files: string[];
    commit?: string;
    description: string;
    expectedEffect: string;
  };
  regressionGuard: {
    protected: string[];
    successCriteria: string[];
  };
  evaluateAfterIssues: number;
}

export interface MaintenanceEvaluation {
  state: "pending" | "validated" | "regressed" | "inconclusive" | "not_applicable";
  evaluatedAt?: string;
  afterIssues: number;
  baseline?: {
    prompts: number;
    freshTokens: number;
    modelDurationMs: number;
  };
  observed?: {
    issueNumbers: number[];
    promptsAverage: number;
    freshTokensAverage: number;
    modelDurationMsAverage: number;
  };
  changesPct?: {
    prompts: number;
    freshTokens: number;
    modelDurationMs: number;
  };
  conclusion?: string;
}

interface MaintenanceRecord {
  runId: string;
  issueNumber: number;
  completedCount: number;
  checkedAt: string;
  reasons: string[];
  tuningRequested: boolean;
  tuningRan: boolean;
  tuningUsage?: ReturnType<typeof sessionUsage>;
  tuningDurationMs?: number;
  metricsCommit?: string;
  note?: string;
  assessment?: MaintenanceAssessmentResult;
  evaluation?: MaintenanceEvaluation;
}

interface MaintenanceState {
  version: 1 | 2;
  runId?: string;
  lastCompletedCount: number;
  history: MaintenanceRecord[];
}

export interface MaintenanceDecision {
  issueNumber: number;
  completedCount: number;
  reasons: string[];
  shouldTune: boolean;
  summary: string;
}

function maintenanceFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-loop-maintenance.json");
}

function maintenanceResultFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-loop-maintenance-result.json");
}

function readMaintenance(cwd: string): MaintenanceState {
  const path = maintenanceFile(cwd);
  if (!existsSync(path)) return { version: 2, lastCompletedCount: 0, history: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MaintenanceState;
    return {
      version: 2,
      runId: parsed.runId,
      lastCompletedCount: Number.isFinite(parsed.lastCompletedCount) ? parsed.lastCompletedCount : 0,
      history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : [],
    };
  } catch {
    return { version: 2, lastCompletedCount: 0, history: [] };
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(after: number, before: number): number {
  return before > 0 ? ((after - before) / before) * 100 : 0;
}

function completedMetrics(state: LoopState): LoopIssueMetrics[] {
  return (state.issueMetrics || []).filter((metric) => metric.disposition === "completed");
}

function freshTokens(metric: LoopIssueMetrics): number {
  return metric.input + metric.output;
}

function freshTokensPerPrompt(metric: LoopIssueMetrics): number {
  return metric.prompts > 0 ? freshTokens(metric) / metric.prompts : 0;
}

function boundedText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function boundedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_TEXT))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function parseAssessmentResult(cwd: string): MaintenanceAssessmentResult | undefined {
  const path = maintenanceResultFile(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const allowedStatuses: MaintenanceAssessmentStatus[] = [
      "healthy_no_change",
      "insufficient_evidence",
      "change_applied",
      "change_requires_reload",
      "change_rejected_by_regression_guard",
      "previous_tuning_rolled_back",
    ];
    const status = allowedStatuses.includes(raw.status as MaintenanceAssessmentStatus)
      ? (raw.status as MaintenanceAssessmentStatus)
      : "insufficient_evidence";
    const actionRaw = (raw.action && typeof raw.action === "object" ? raw.action : {}) as Record<string, unknown>;
    const guardRaw = (raw.regressionGuard && typeof raw.regressionGuard === "object" ? raw.regressionGuard : {}) as Record<string, unknown>;
    const horizon = Number(raw.evaluateAfterIssues);
    return {
      status,
      summary: boundedText(raw.summary, "Assessment completed without a structured summary"),
      rootCauses: boundedStrings(raw.rootCauses),
      evidence: boundedStrings(raw.evidence),
      confidence: ["low", "medium", "high"].includes(String(raw.confidence))
        ? (raw.confidence as "low" | "medium" | "high")
        : "low",
      action: {
        changed: actionRaw.changed === true,
        files: boundedStrings(actionRaw.files),
        commit: boundedText(actionRaw.commit) || undefined,
        description: boundedText(actionRaw.description, "No behavior change recorded"),
        expectedEffect: boundedText(actionRaw.expectedEffect, "No measurable effect claimed"),
      },
      regressionGuard: {
        protected: boundedStrings(guardRaw.protected),
        successCriteria: boundedStrings(guardRaw.successCriteria),
      },
      evaluateAfterIssues: Number.isFinite(horizon)
        ? Math.min(5, Math.max(1, Math.floor(horizon)))
        : EVALUATE_AFTER_ISSUES,
    };
  } catch {
    return undefined;
  } finally {
    removeFile(path);
  }
}

function defaultAssessment(note: string): MaintenanceAssessmentResult {
  return {
    status: "insufficient_evidence",
    summary: note.slice(0, MAX_TEXT),
    rootCauses: [],
    evidence: [],
    confidence: "low",
    action: {
      changed: false,
      files: [],
      description: "No structured tuning action was recorded",
      expectedEffect: "None",
    },
    regressionGuard: { protected: [], successCriteria: [] },
    evaluateAfterIssues: EVALUATE_AFTER_ISSUES,
  };
}

function initialEvaluation(
  assessment: MaintenanceAssessmentResult,
  baseline?: LoopIssueMetrics,
): MaintenanceEvaluation {
  const changed = assessment.action.changed && ["change_applied", "change_requires_reload", "previous_tuning_rolled_back"].includes(assessment.status);
  if (!changed || !baseline) {
    return { state: "not_applicable", afterIssues: assessment.evaluateAfterIssues };
  }
  return {
    state: "pending",
    afterIssues: assessment.evaluateAfterIssues,
    baseline: {
      prompts: baseline.prompts,
      freshTokens: baseline.input + baseline.output,
      modelDurationMs: baseline.modelDurationMs,
    },
  };
}

function evaluatePending(history: MaintenanceRecord[], state: LoopState): MaintenanceRecord[] {
  return history.map((record) => {
    if (record.evaluation?.state !== "pending" || !record.evaluation.baseline) return record;
    const horizon = record.evaluation.afterIssues || EVALUATE_AFTER_ISSUES;
    const subsequentIssueNumbers = state.completedIssues.slice(record.completedCount, record.completedCount + horizon);
    if (subsequentIssueNumbers.length < horizon) return record;
    const metrics = subsequentIssueNumbers
      .map((issue) => state.issueMetrics.find((item) => item.issueNumber === issue && item.disposition === "completed"))
      .filter((item): item is LoopIssueMetrics => Boolean(item));
    if (metrics.length < horizon) return record;

    const baseline = record.evaluation.baseline;
    const observed = {
      issueNumbers: metrics.map((item) => item.issueNumber),
      promptsAverage: average(metrics.map((item) => item.prompts)),
      freshTokensAverage: average(metrics.map((item) => item.input + item.output)),
      modelDurationMsAverage: average(metrics.map((item) => item.modelDurationMs)),
    };
    const changesPct = {
      prompts: pct(observed.promptsAverage, baseline.prompts),
      freshTokens: pct(observed.freshTokensAverage, baseline.freshTokens),
      modelDurationMs: pct(observed.modelDurationMsAverage, baseline.modelDurationMs),
    };
    const values = Object.values(changesPct);
    const clearRegression = values.some((value) => value >= 25);
    const improvements = values.filter((value) => value <= -10).length;
    const stateValue: MaintenanceEvaluation["state"] = clearRegression
      ? "regressed"
      : improvements >= 2
        ? "validated"
        : "inconclusive";
    const conclusion = clearRegression
      ? "Directional post-change telemetry regressed by at least 25% on one efficiency dimension; inspect before retaining the tuning."
      : improvements >= 2
        ? "Directional post-change telemetry improved by at least 10% on two efficiency dimensions with no >=25% regression."
        : "Post-change telemetry is mixed or too small to validate the tuning; retain only with other evidence.";
    return {
      ...record,
      evaluation: {
        ...record.evaluation,
        state: stateValue,
        evaluatedAt: loopNow(),
        observed,
        changesPct,
        conclusion,
      },
    };
  });
}

export function maintenanceOwed(cwd: string, state: LoopState): boolean {
  const maintenance = readMaintenance(cwd);
  if (maintenance.runId !== state.runId) return state.completedIssues.length > 0;
  return state.completedIssues.length > maintenance.lastCompletedCount;
}

export function maintenanceDecision(state: LoopState): MaintenanceDecision | null {
  const completedCount = state.completedIssues.length;
  if (!completedCount) return null;
  const issueNumber = state.completedIssues[completedCount - 1];
  const metrics = (state.issueMetrics || []).find((item) => item.issueNumber === issueNumber);
  const peers = completedMetrics(state).filter((item) => item.issueNumber !== issueNumber);
  const reasons: string[] = [];

  if (!metrics) {
    reasons.push("completed issue has no bounded per-issue telemetry");
  } else {
    const issueFreshTokens = freshTokens(metrics);

    if (metrics.prompts >= SEVERE_PROMPTS) {
      reasons.push(`severe transition count (${metrics.prompts} prompts)`);
    }
    if (metrics.sessions >= SEVERE_SESSIONS) {
      reasons.push(`severe session count (${metrics.sessions} sessions)`);
    }
    if (issueFreshTokens >= SEVERE_FRESH_TOKENS) {
      reasons.push(`severe fresh token use (${Math.round(issueFreshTokens)} input+output)`);
    }
    if (metrics.modelDurationMs >= SEVERE_WALL_MS) {
      reasons.push(`severe accumulated transition wall time (${(metrics.modelDurationMs / 60_000).toFixed(1)} min)`);
    }

    if (peers.length >= MIN_RELATIVE_PEERS) {
      const peerPromptMedian = median(peers.map((item) => item.prompts));
      const peerFreshMedian = median(peers.map(freshTokens));
      const peerDurationMedian = median(peers.map((item) => item.modelDurationMs));
      const peerDensityMedian = median(peers.map(freshTokensPerPrompt));
      const issueDensity = freshTokensPerPrompt(metrics);

      if (
        peerPromptMedian >= 2 &&
        metrics.prompts >= Math.max(6, peerPromptMedian * RELATIVE_MULTIPLIER)
      ) {
        reasons.push(`prompt count is a clear outlier vs completed-issue median ${peerPromptMedian.toFixed(1)}`);
      }
      if (
        peerFreshMedian >= 20_000 &&
        issueFreshTokens >= Math.max(MIN_RELATIVE_FRESH_TOKENS, peerFreshMedian * RELATIVE_MULTIPLIER)
      ) {
        reasons.push(`fresh token use is a clear outlier vs completed-issue median ${Math.round(peerFreshMedian)}`);
      }
      if (
        peerDurationMedian >= 60_000 &&
        metrics.modelDurationMs >= Math.max(MIN_RELATIVE_WALL_MS, peerDurationMedian * RELATIVE_MULTIPLIER)
      ) {
        reasons.push(`transition wall time is a clear outlier vs completed-issue median ${(peerDurationMedian / 60_000).toFixed(1)} min`);
      }
      if (
        peerDensityMedian > 0 &&
        issueDensity >= Math.max(MIN_DENSE_PROMPT_TOKENS, peerDensityMedian * RELATIVE_MULTIPLIER)
      ) {
        reasons.push(`fresh tokens per prompt is a clear outlier vs completed-issue median ${Math.round(peerDensityMedian)}`);
      }
    }
  }

  const periodic = completedCount % PERIODIC_REVIEW_EVERY === 0;
  if (periodic) reasons.push(`periodic ${PERIODIC_REVIEW_EVERY}-issue regression review`);
  const shouldTune = reasons.length > 0;
  const summary = metrics
    ? `issue=#${issueNumber} prompts=${metrics.prompts} sessions=${metrics.sessions} input=${metrics.input} output=${metrics.output} cacheRead=${metrics.cacheRead} total=${metrics.totalTokens} transitionWallMs=${metrics.modelDurationMs} cost=${metrics.cost}`
    : `issue=#${issueNumber} telemetry=missing`;
  return { issueNumber, completedCount, reasons, shouldTune, summary };
}

function recordMaintenance(
  cwd: string,
  state: LoopState,
  record: Omit<MaintenanceRecord, "runId">,
): void {
  const current = readMaintenance(cwd);
  const evaluated = evaluatePending(current.history, state);
  const history = [...evaluated, { ...record, runId: state.runId }].slice(-MAX_HISTORY);
  writeJsonAtomic(maintenanceFile(cwd), {
    version: 2,
    runId: state.runId,
    lastCompletedCount: record.completedCount,
    history,
  });
}

export async function runIssueBoundaryMaintenance(
  ctx: ExtensionCommandContext,
  state: LoopState,
  decision: MaintenanceDecision = maintenanceDecision(state) as MaintenanceDecision,
  worker: IssueWorkerRunner = runIssueWorker,
): Promise<void> {
  if (!decision) return;

  const beforeBoundary = await safeLoopBoundary(ctx.cwd, true);
  if (!beforeBoundary.safe) throw new Error(`Cannot run issue-boundary maintenance from unsafe state: ${beforeBoundary.reason}`);

  const baseline = state.issueMetrics.find((item) => item.issueNumber === decision.issueNumber);
  const modelBefore = observedSessionModel(ctx);
  if (!decision.shouldTune) {
    const assessment: MaintenanceAssessmentResult = {
      status: "healthy_no_change",
      summary: `Deterministic checkpoint healthy: ${decision.summary}`.slice(0, MAX_TEXT),
      rootCauses: [],
      evidence: [],
      confidence: "high",
      action: { changed: false, files: [], description: "No tuning needed", expectedEffect: "None" },
      regressionGuard: { protected: [], successCriteria: [] },
      evaluateAfterIssues: EVALUATE_AFTER_ISSUES,
    };
    const metricsCommit = await publishIssuePerformanceMetrics(
      ctx.cwd,
      state,
      decision.issueNumber,
      {
        triggered: false,
        reasons: [],
        assessmentStatus: assessment.status,
        behaviorChanged: false,
        model: modelBefore,
      },
    );
    recordMaintenance(ctx.cwd, state, {
      issueNumber: decision.issueNumber,
      completedCount: decision.completedCount,
      checkedAt: loopNow(),
      reasons: [],
      tuningRequested: false,
      tuningRan: false,
      metricsCommit,
      assessment,
      evaluation: initialEvaluation(assessment, baseline),
      note: assessment.summary,
    });
    return;
  }

  removeFile(maintenanceResultFile(ctx.cwd));
  const before = sessionUsage(ctx);
  const started = Date.now();
  let note = "maintenance assessment completed";
  try {
    const result = await worker(
      ctx.cwd,
      buildLoopMaintenancePrompt(ctx.cwd, decision),
    );
    if (!result.ok) {
      throw new Error(
        `Issue worker failed (${result.signal || `exit ${result.code ?? "unknown"}`})`,
      );
    }
  } catch (error) {
    note = `maintenance model assessment failed cleanly: ${error instanceof Error ? error.message : String(error)}`;
  }
  const tuningDurationMs = Date.now() - started;
  const tuningUsage = {
    ...emptyLoopMetrics(),
    ...usageDelta(sessionUsage(ctx), before),
    sessions: 1,
    prompts: 1,
    modelDurationMs: tuningDurationMs,
  };

  const assessment = parseAssessmentResult(ctx.cwd) || defaultAssessment(note);
  const afterBoundary = await safeLoopBoundary(ctx.cwd, true);
  if (!afterBoundary.safe) throw new Error(`Issue-boundary maintenance left unsafe state: ${afterBoundary.reason}`);

  const metricsCommit = await publishIssuePerformanceMetrics(
    ctx.cwd,
    state,
    decision.issueNumber,
    {
      triggered: true,
      reasons: decision.reasons,
      assessmentStatus: assessment.status,
      behaviorChanged: assessment.action.changed,
      usage: tuningUsage,
      durationMs: tuningDurationMs,
      model: observedSessionModel(ctx) || modelBefore,
    },
  );

  recordMaintenance(ctx.cwd, state, {
    issueNumber: decision.issueNumber,
    completedCount: decision.completedCount,
    checkedAt: loopNow(),
    reasons: decision.reasons,
    tuningRequested: true,
    tuningRan: true,
    tuningUsage,
    tuningDurationMs,
    metricsCommit,
    assessment,
    evaluation: initialEvaluation(assessment, baseline),
    note: assessment.summary,
  });
}

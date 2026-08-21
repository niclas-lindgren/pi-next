/** Persistent, bounded runtime side of the self-assessment controller. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PiNextConfig } from "../../src/coordination/config.ts";
import {
  DEFAULT_HEALTH_POLICY,
  emptyHealthState,
  evaluateHealth,
  findingFromHealth,
  findingPublicationEligible,
  mergeSelfAssessmentFinding,
  type HealthAssessment,
  type HealthObservation,
  type HealthState,
  type SelfAssessmentFinding,
} from "../../src/coordination/self-assessment.ts";
import type { WorkAuthorityAdapter } from "../../src/coordination/work-authority.ts";
import { reportRuntimeFailure } from "./feedback-runtime.ts";
import { sanitizeFeedbackText } from "../../src/coordination/feedback.ts";
import { runtimeDir, writeJsonAtomic } from "./util.ts";

const MAX_FINDINGS = 100;
const MAX_FAILURES = 100;

interface HealthFile {
  version: 1;
  state: HealthState;
}

interface FindingFile {
  version: 1;
  findings: SelfAssessmentFinding[];
}

export function healthStateFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-health.json");
}

export function selfAssessmentFindingsFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-findings.json");
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export function readHealthState(cwd: string): HealthState | undefined {
  return readJson<HealthFile>(healthStateFile(cwd))?.state;
}

export function readSelfAssessmentFindings(cwd: string): SelfAssessmentFinding[] {
  const value = readJson<FindingFile>(selfAssessmentFindingsFile(cwd));
  return Array.isArray(value?.findings) ? value!.findings.slice(-MAX_FINDINGS) : [];
}

/** Persist a held finding produced by deterministic maintenance evaluation. */
export function persistSelfAssessmentFinding(cwd: string, finding: SelfAssessmentFinding): void {
  saveFindings(cwd, mergeSelfAssessmentFinding(readSelfAssessmentFindings(cwd), finding));
}

function saveHealth(cwd: string, state: HealthState): void {
  // Failure and command maps are recurrence indexes, not logs. Keep their
  // cardinality bounded so a long-running process cannot grow this file.
  const bounded: HealthState = {
    ...state,
    failureCounts: Object.fromEntries(Object.entries(state.failureCounts).slice(-MAX_FAILURES)),
    commandCounts: Object.fromEntries(Object.entries(state.commandCounts).slice(-MAX_FAILURES)),
  };
  writeJsonAtomic(healthStateFile(cwd), { version: 1, state: bounded });
}

function saveFindings(cwd: string, findings: SelfAssessmentFinding[]): void {
  writeJsonAtomic(selfAssessmentFindingsFile(cwd), { version: 1, findings: findings.slice(-MAX_FINDINGS) });
}

export interface ObserveTransitionResult {
  assessment: HealthAssessment;
  finding?: SelfAssessmentFinding;
}

type RuntimeAssessmentConfig = Pick<PiNextConfig["assessment"],
  "enabled" | "noProgressThreshold" | "repeatedFailureThreshold" | "repeatedCommandThreshold" | "contextPressureThreshold"
>;

/** Evaluate health after every managed transition. No model is called here. */
export async function observeManagedTransition(
  cwd: string,
  observation: HealthObservation,
  config?: { assessment: RuntimeAssessmentConfig },
): Promise<ObserveTransitionResult> {
  if (config?.assessment && !config.assessment.enabled) {
    return {
      assessment: {
        state: readHealthState(cwd) || emptyHealthState(),
        signals: [],
        strategy: "none",
        reason: "self-assessment is disabled by configuration",
      },
    };
  }
  const policy = config?.assessment || {
    ...DEFAULT_HEALTH_POLICY,
    findingRecurrenceThreshold: 3,
    findingMinConfidence: "high" as const,
  };
  const assessment = evaluateHealth(readHealthState(cwd), observation, {
    noProgressThreshold: policy.noProgressThreshold,
    repeatedFailureThreshold: policy.repeatedFailureThreshold,
    repeatedCommandThreshold: policy.repeatedCommandThreshold,
    contextPressureThreshold: policy.contextPressureThreshold,
    tokenAccelerationThreshold: DEFAULT_HEALTH_POLICY.tokenAccelerationThreshold,
    maxMaintenanceOverheadShare: DEFAULT_HEALTH_POLICY.maxMaintenanceOverheadShare,
  });
  saveHealth(cwd, assessment.state);

  let finding: SelfAssessmentFinding | undefined;
  if (assessment.strategy === "escalate") {
    const existing = readSelfAssessmentFindings(cwd).find((item) => item.fingerprint === assessment.fingerprint);
    finding = findingFromHealth(assessment, {
      runId: observation.runId,
      issueNumber: observation.issueNumber,
      proposedAction: "Inspect the recurring deterministic health signal and implement a reviewed bounded fix; do not weaken authority, verification, or finalization invariants.",
    });
    if (finding) {
      finding.recurrence = (existing?.recurrence || 0) + 1;
      finding.approvalState = existing?.approvalState || "pending_review";
      saveFindings(cwd, mergeSelfAssessmentFinding(readSelfAssessmentFindings(cwd), finding));
      // Feedback remains useful to existing consumers, but is deliberately
      // separate from backlog publication to avoid issue storms.
      await reportRuntimeFailure(cwd, {
        stage: "self-assessment",
        category: "runtime",
        severity: finding.severity === "P1" ? "fatal" : "error",
        outcome: "escalated",
        code: "systemic_health_anomaly",
        summary: assessment.reason,
        issueNumber: observation.issueNumber,
        runId: observation.runId,
      });
    }
  }
  return { assessment, finding };
}

/** Publish only sufficiently evidenced findings, and update the same item on recurrence. */
export async function publishSelfAssessmentFindings(
  cwd: string,
  authority: WorkAuthorityAdapter,
  config: Pick<PiNextConfig, "assessment">,
): Promise<SelfAssessmentFinding[]> {
  const findings = readSelfAssessmentFindings(cwd);
  const next = findings.map((finding) => {
    const eligible = findingPublicationEligible(finding, {
      recurrenceThreshold: config.assessment.findingRecurrenceThreshold,
      minConfidence: config.assessment.findingMinConfidence,
    });
    return finding.authorityId ? finding : { ...finding, publication: {
      status: eligible ? "eligible_not_attempted" as const : "not_eligible" as const,
      reason: eligible ? "publication adapter unavailable" : `recurrence ${finding.recurrence}/${config.assessment.findingRecurrenceThreshold} or confidence below ${config.assessment.findingMinConfidence}`,
      retry: "next issue boundary",
    } };
  });
  if (!authority.publishFinding) {
    saveFindings(cwd, next);
    return next;
  }
  for (const finding of findings) {
    const eligible = findingPublicationEligible(finding, {
      recurrenceThreshold: config.assessment.findingRecurrenceThreshold,
      minConfidence: config.assessment.findingMinConfidence,
    });
    if (!eligible) {
      const index = next.findIndex((item) => item.fingerprint === finding.fingerprint);
      if (index >= 0 && !finding.authorityId) {
        next[index] = { ...finding, publication: {
          status: "not_eligible" as const,
          reason: `recurrence ${finding.recurrence}/${config.assessment.findingRecurrenceThreshold} or confidence below ${config.assessment.findingMinConfidence}`,
          retry: "next issue boundary",
        } };
      }
      continue;
    }
    const attemptedAt = new Date().toISOString();
    try {
      const updating = Boolean(finding.authorityId && authority.updateFinding);
      const result = updating
        ? await authority.updateFinding!(finding.authorityId!, finding, config)
        : await authority.publishFinding(finding, config);
      const index = next.findIndex((item) => item.fingerprint === finding.fingerprint);
      if (index >= 0) next[index] = { ...finding, authorityId: result.id, authorityUrl: result.url, publication: {
        status: updating ? ("updated" as const) : ("published" as const), attemptedAt, adapter: authority.name,
        authorityId: result.id, authorityUrl: result.url,
      } };
    } catch (error) {
      const index = next.findIndex((item) => item.fingerprint === finding.fingerprint);
      if (index >= 0) next[index] = { ...finding, publication: {
        status: "publication_failed" as const, attemptedAt, adapter: authority.name,
        reason: sanitizeFeedbackText(error instanceof Error ? error.message : String(error)).slice(0, 240),
        retry: "next issue boundary",
      } };
      // Publication is best effort. The evidence remains local and can be
      // retried at the next bounded review without duplicating an issue.
    }
  }
  saveFindings(cwd, next);
  return next;
}

/** Pull approval from the shared authority; local labels are never approval evidence. */
export async function refreshFindingApprovals(
  cwd: string,
  authority: WorkAuthorityAdapter,
  config: Pick<PiNextConfig, "assessment">,
): Promise<SelfAssessmentFinding[]> {
  if (!authority.readFindingApproval) return readSelfAssessmentFindings(cwd);
  const findings = readSelfAssessmentFindings(cwd);
  const next = await Promise.all(findings.map(async (finding) => {
    if (!finding.authorityId) return finding;
    try {
      return { ...finding, approvalState: await authority.readFindingApproval!(finding.authorityId, config) };
    } catch (error) {
      return { ...finding, publication: {
        status: "approval_refresh_failed" as const, attemptedAt: new Date().toISOString(),
        adapter: authority.name,
        reason: sanitizeFeedbackText(error instanceof Error ? error.message : String(error)).slice(0, 240),
        retry: "next issue boundary",
      } };
    }
  }));
  saveFindings(cwd, next);
  return next;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { runtimeDir, writeJsonAtomic } from "./util-core.ts";

/** One bounded bookkeeping budget spans planning, verification, lifecycle,
 * archive, diagnostics, and performance evidence. */
export const WORKFLOW_ONLY_COMMIT_LIMIT = 2;

export type CommitKind = "substantive" | "workflow-only" | "lifecycle";
export type TransitionKind = "verification" | "lifecycle" | "repair" | "issue-switch" | "task";
export type CorrectnessTransitionReason =
  | "authority_reconciliation"
  | "recovery_state"
  | "terminal_transition"
  | "post_integration_cleanup";

/** A narrowly classified exception to the ordinary workflow-only budget. */
export interface CorrectnessTransition {
  reason: CorrectnessTransitionReason;
  /** Stable authority/code fingerprint; never a timestamp or raw output. */
  fingerprint: string;
}

export interface IssueCommitTelemetry {
  total: number;
  substantive: number;
  workflowOnly: number;
  lifecycle: number;
  verificationAttempts: number;
  lifecycleTransitions: number;
  hookExecutions: number;
  correctnessTransitions: number;
  correctnessByFingerprint: Record<string, number>;
  transitionCounts: Record<string, number>;
}

export interface CommitTelemetry {
  version: 1;
  issues: Record<string, IssueCommitTelemetry>;
}

export function commitTelemetryFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-commit-telemetry.json");
}

function emptyIssue(): IssueCommitTelemetry {
  return {
    total: 0,
    substantive: 0,
    workflowOnly: 0,
    lifecycle: 0,
    verificationAttempts: 0,
    lifecycleTransitions: 0,
    hookExecutions: 0,
    correctnessTransitions: 0,
    correctnessByFingerprint: {},
    transitionCounts: {},
  };
}

function normalizeIssue(value: Partial<IssueCommitTelemetry> | undefined): IssueCommitTelemetry {
  const base = emptyIssue();
  return {
    ...base,
    ...value,
    correctnessByFingerprint: value?.correctnessByFingerprint && typeof value.correctnessByFingerprint === "object"
      ? value.correctnessByFingerprint
      : {},
    transitionCounts: value?.transitionCounts && typeof value.transitionCounts === "object"
      ? value.transitionCounts
      : {},
  };
}

export function readCommitTelemetry(cwd: string): CommitTelemetry {
  const file = commitTelemetryFile(cwd);
  if (!existsSync(file)) return { version: 1, issues: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CommitTelemetry>;
    const issues = parsed.issues && typeof parsed.issues === "object" ? parsed.issues : {};
    return {
      version: 1,
      issues: Object.fromEntries(
        Object.entries(issues).map(([key, value]) => [key, normalizeIssue(value)]),
      ),
    };
  } catch {
    return { version: 1, issues: {} };
  }
}

function issueState(state: CommitTelemetry, issue: number): IssueCommitTelemetry {
  const key = String(issue);
  const current = normalizeIssue(state.issues[key]);
  state.issues[key] = current;
  return current;
}

export function classifyCommitPaths(paths: string[], cwd = process.cwd()): CommitKind {
  const config = loadPiNextConfig(cwd);
  const stateDir = config.workflow.stateDir.replace(/\\/g, "/").replace(/\/$/, "");
  const diagnosticsDir = config.workflow.diagnosticsPath.replace(/\\/g, "/").replace(/\/$/, "");
  const workflowOnly = paths.length > 0 && paths.every((path) =>
    (path === `${stateDir}/PLAN.md` || (path.startsWith(`${stateDir}/PLAN-`) && path.endsWith(".md"))) ||
    path === `${stateDir}/VERIFY.md` ||
    path === `${stateDir}/HISTORY.md` ||
    path.startsWith(`${stateDir}/ARCHIVED/`) ||
    path.startsWith(`${stateDir}/deferred/`) ||
    path.startsWith(`${diagnosticsDir}/`),
  );
  return workflowOnly ? "workflow-only" : "substantive";
}

function correctnessKey(transition: CorrectnessTransition): string {
  return `${transition.reason}:${transition.fingerprint}`;
}

export function assertWorkflowCommitAllowed(
  cwd: string,
  issue: number | undefined,
  correctness?: CorrectnessTransition,
): void {
  if (!issue) return;
  const current = normalizeIssue(readCommitTelemetry(cwd).issues[String(issue)]);
  if (current.workflowOnly + current.lifecycle < WORKFLOW_ONLY_COMMIT_LIMIT) return;
  if (
    !correctness ||
    !correctness.fingerprint.trim() ||
    correctness.fingerprint.trim().length > 256
  ) {
    throw new Error(
      `Workflow-only/lifecycle commit bound reached for issue #${issue} (${WORKFLOW_ONLY_COMMIT_LIMIT}); batch bookkeeping with substantive work or one lifecycle checkpoint`,
    );
  }
  const key = correctnessKey(correctness);
  if (current.correctnessByFingerprint[key]) {
    throw new Error(
      `Correctness transition already recorded for issue #${issue} (${correctness.reason}, ${correctness.fingerprint}); refusing duplicate terminal escape`,
    );
  }
}

export function recordCommit(
  cwd: string,
  issue: number | undefined,
  kind: CommitKind,
  correctness?: CorrectnessTransition,
): void {
  if (!issue) return;
  const state = readCommitTelemetry(cwd);
  const key = String(issue);
  const current = issueState(state, issue);
  state.issues[key] = {
    ...current,
    total: current.total + 1,
    substantive: current.substantive + (kind === "substantive" ? 1 : 0),
    workflowOnly: current.workflowOnly + (kind === "workflow-only" ? 1 : 0),
    lifecycle: current.lifecycle + (kind === "lifecycle" ? 1 : 0),
    hookExecutions: current.hookExecutions + 1,
    correctnessTransitions: current.correctnessTransitions + (correctness ? 1 : 0),
    correctnessByFingerprint: correctness
      ? {
          ...current.correctnessByFingerprint,
          [correctnessKey(correctness)]: (current.correctnessByFingerprint[correctnessKey(correctness)] || 0) + 1,
        }
      : current.correctnessByFingerprint,
  };
  writeJsonAtomic(commitTelemetryFile(cwd), state);
}

export function recordTransition(
  cwd: string,
  issue: number | null | undefined,
  kind: TransitionKind,
): void {
  if (!issue) return;
  const state = readCommitTelemetry(cwd);
  const current = issueState(state, issue);
  current.transitionCounts[kind] = (current.transitionCounts[kind] || 0) + 1;
  if (kind === "verification") current.verificationAttempts += 1;
  if (kind === "lifecycle" || kind === "issue-switch") current.lifecycleTransitions += 1;
  writeJsonAtomic(commitTelemetryFile(cwd), state);
}

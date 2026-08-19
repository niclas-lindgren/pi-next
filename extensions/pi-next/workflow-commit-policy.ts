import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPiNextConfig } from "../../src/coordination/config.ts";
import { runtimeDir, writeJsonAtomic } from "./util-core.ts";

/** One bounded bookkeeping budget spans planning, verification, lifecycle,
 * archive, diagnostics, and performance evidence. */
export const WORKFLOW_ONLY_COMMIT_LIMIT = 2;

export type CommitKind = "substantive" | "workflow-only" | "lifecycle";
export type TransitionKind = "verification" | "lifecycle" | "repair" | "issue-switch" | "task";

export interface IssueCommitTelemetry {
  total: number;
  substantive: number;
  workflowOnly: number;
  lifecycle: number;
  verificationAttempts: number;
  lifecycleTransitions: number;
  hookExecutions: number;
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
    transitionCounts: {},
  };
}

function normalizeIssue(value: Partial<IssueCommitTelemetry> | undefined): IssueCommitTelemetry {
  const base = emptyIssue();
  return {
    ...base,
    ...value,
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
  const stateDir = loadPiNextConfig(cwd).workflow.stateDir.replace(/\\/g, "/").replace(/\/$/, "");
  const workflowOnly = paths.length > 0 && paths.every((path) =>
    (path === `${stateDir}/PLAN.md` || (path.startsWith(`${stateDir}/PLAN-`) && path.endsWith(".md"))) ||
    path === `${stateDir}/VERIFY.md` ||
    path === `${stateDir}/HISTORY.md` ||
    path.startsWith(`${stateDir}/ARCHIVED/`) ||
    path.startsWith(`${stateDir}/deferred/`) ||
    path.startsWith(".agents/diagnostics/pi-next/"),
  );
  return workflowOnly ? "workflow-only" : "substantive";
}

export function assertWorkflowCommitAllowed(cwd: string, issue: number | undefined): void {
  if (!issue) return;
  const current = normalizeIssue(readCommitTelemetry(cwd).issues[String(issue)]);
  if (current.workflowOnly + current.lifecycle >= WORKFLOW_ONLY_COMMIT_LIMIT) {
    throw new Error(
      `Workflow-only/lifecycle commit bound reached for issue #${issue} (${WORKFLOW_ONLY_COMMIT_LIMIT}); batch bookkeeping with substantive work or one lifecycle checkpoint`,
    );
  }
}

export function recordCommit(
  cwd: string,
  issue: number | undefined,
  kind: CommitKind,
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

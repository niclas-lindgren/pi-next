import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { issueWorkspaceIdentity, parseLeaseFromAuthority } from "./issue-leases.ts";
import type { LoopState } from "./loop-state.ts";
import { validatePlan } from "./plan.ts";
import { getLiveIssueFingerprint } from "./issue-freshness.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import type { WorkAuthorityAdapter } from "../../src/coordination/work-authority.ts";
import { workflowArtifacts } from "./plan-read.ts";
import { PlanAuthorityError, planFile, resolvePlanIdentity } from "./util-core.ts";

/**
 * Validate the durable execution boundary before any worker can run. A plan
 * is recoverable state, not authority: every resumed turn must still have
 * the exact live lease and the exact derived issue worktree.
 */
export function validateCanonicalExecutionState(
  executionCwd: string,
  state: LoopState,
): void {
  const issueNumber = state.activeIssueNumber;
  const persistedLease = state.activeLease;
  const workspace = state.activeWorkspace;
  if (
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    !persistedLease ||
    !workspace
  ) {
    throw new PlanAuthorityError(
      "unowned",
      "Issue-plan execution requires validated ownership and a canonical workspace before model execution",
    );
  }

  let lease;
  try {
    lease = parseLeaseFromAuthority(JSON.stringify(persistedLease));
  } catch (error) {
    throw new PlanAuthorityError(
      "unowned",
      `Persisted issue lease is malformed; refusing resume: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (lease.issueNumber !== issueNumber || lease.agent !== "pi-next") {
    throw new PlanAuthorityError(
      "unowned",
      `Persisted issue lease does not own issue #${issueNumber}; refusing resume`,
    );
  }

  const coordinationCwd = state.coordinationCwd || executionCwd;
  const canonicalWorkspace = resolve(
    coordinationCwd,
    issueWorkspaceIdentity(issueNumber).worktree,
  );
  if (workspace !== canonicalWorkspace || resolve(executionCwd) !== canonicalWorkspace) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} execution is not attached to its canonical workspace`,
      [workspace, canonicalWorkspace],
    );
  }
}

/** Validate all workflow artifacts before a resumed worker transition. */
interface PlanRepair {
  path: string;
  fields: string[];
}

/**
 * Task metadata is workflow structure, not product authority. It may be
 * repaired by the bounded planning worker, but every other validation defect
 * remains fail-closed until it is reconciled from live authority.
 */
export function isPlanTaskMetadataDefect(errors: readonly string[]): boolean {
  return errors.length > 0 && errors.every((error) =>
    /^Task missing (?:Files|Approach): /.test(error),
  );
}

export interface PendingPlanRepair {
  path: string;
  errors: string[];
  /** Stable across task-name/line-number changes for bounded retry accounting. */
  fingerprint: string;
}

export function pendingPlanRepair(
  workspace: string,
  issueNumber: number,
): PendingPlanRepair | undefined {
  const plan = resolvePlanIdentity(workspace);
  if (
    plan.kind !== "resolved" ||
    plan.issueNumber !== issueNumber ||
    plan.provenance !== "canonical"
  ) return undefined;
  const errors = validatePlan(readFileSync(plan.path, "utf8"));
  if (!isPlanTaskMetadataDefect(errors)) return undefined;
  const files = errors.filter((error) => error.startsWith("Task missing Files:")).length;
  const approaches = errors.filter((error) => error.startsWith("Task missing Approach:")).length;
  return {
    path: plan.path,
    errors,
    fingerprint: `task-metadata:files=${files};approaches=${approaches}`,
  };
}

/** Repair only formatting that cannot change issue authority or task meaning. */
function repairPlanStructure(
  path: string,
  plan: string,
  issueNumber: number,
): PlanRepair | undefined {
  const errors = validatePlan(plan);
  if (!errors.length) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  // Mechanical repairs are independent of semantic errors. A missing
  // acceptance section must not prevent safe heading/log repair first.
  let repaired = plan;
  const fields: string[] = [];
  if (errors.includes("Missing # Plan:")) {
    repaired = `# Plan: Issue #${issueNumber}\n\n${repaired}`;
    fields.push("title");
  }
  if (errors.includes("Missing **GitHub-Issue:** N")) {
    const goal = repaired.match(/^\*\*Goal:\*\*.*$/m);
    const identity = `**GitHub-Issue:** #${issueNumber}`;
    repaired = goal
      ? repaired.replace(goal[0], `${goal[0]}\n\n${identity}`)
      : `${repaired.replace(/\s*$/, "")}\n\n${identity}\n`;
    fields.push("issue identity");
  }
  if (errors.includes("Missing ## Log")) {
    repaired = `${repaired.replace(/\s*$/, "")}\n\n## Log\n`;
    fields.push("log");
  }
  if (repaired === plan) return undefined;

  const temporary = `${path}.repair-${process.pid}`;
  try {
    writeFileSync(temporary, repaired, "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, fields };
}

function validateArtifactOwnership(workspace: string, issueNumber: number): ReturnType<typeof workflowArtifacts> {
  const artifacts = workflowArtifacts(workspace);
  const canonicalPlan = resolve(planFile(workspace));
  const invalidArtifacts = artifacts.filter(
    (artifact) => artifact.issueNumber !== issueNumber &&
      !(artifact.kind === "plan" && resolve(artifact.path) === canonicalPlan && artifact.issueNumber === undefined),
  );
  if (invalidArtifacts.length) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace contains a foreign or malformed workflow artifact: ${invalidArtifacts.map((artifact) => artifact.path).join(", ")}`,
      invalidArtifacts.map((artifact) => artifact.path),
    );
  }
  return artifacts;
}

export function validateWorkspacePlan(
  workspace: string,
  issueNumber: number,
  options: { runId?: string; allowSemantic?: boolean; allowTaskMetadata?: boolean } = {},
): void {
  const artifacts = validateArtifactOwnership(workspace, issueNumber);
  const plans = artifacts.filter((artifact) => artifact.kind === "plan");
  if (plans.length > 1) {
    throw new PlanAuthorityError(
      "ambiguous",
      "Multiple PLAN artifacts require explicit authority reconciliation before resume",
      plans.map((artifact) => artifact.path),
    );
  }

  let plan = resolvePlanIdentity(workspace);
  if (plan.kind === "unresolved" || plan.kind === "ambiguous") {
    const canonicalPath = resolve(planFile(workspace));
    if (plan.kind === "unresolved" && existsSync(canonicalPath)) {
      const repair = repairPlanStructure(canonicalPath, readFileSync(canonicalPath, "utf8"), issueNumber);
      if (repair) {
        plan = resolvePlanIdentity(workspace);
        if (plan.kind === "resolved") {
          recordLifecycleEvent(workspace, {
            event: "plan_repaired",
            issueNumber,
            runId: options.runId || "unknown",
            outcome: "recovered",
            reasonCode: "plan_repaired",
            repair: { paths: [canonicalPath], fields: repair.fields },
          });
        }
      }
    }
  }
  // A clean issue boundary legitimately has no PLAN yet; the next worker
  // owns planning. Only an existing ambiguous/unresolved artifact is unsafe.
  if (plan.kind === "none") return;
  if (plan.kind !== "resolved") {
    throw new PlanAuthorityError(plan.kind, plan.reason, plan.paths);
  }
  if (plan.issueNumber !== issueNumber) {
    throw new PlanAuthorityError(
      "unowned",
      `Active workspace PLAN resolves to issue #${plan.issueNumber}, not #${issueNumber}`,
      [plan.path],
    );
  }
  if (plan.provenance !== "canonical") {
    throw new PlanAuthorityError(
      "unowned",
      "Legacy issue-scoped PLAN artifacts require explicit authority reconciliation before resume",
      [plan.path],
    );
  }
  const contents = readFileSync(plan.path, "utf8");
  const repair = repairPlanStructure(plan.path, contents, issueNumber);
  if (repair) {
    const repairedErrors = validatePlan(readFileSync(plan.path, "utf8"));
    if (
      repairedErrors.length &&
      !options.allowSemantic &&
      !(options.allowTaskMetadata && isPlanTaskMetadataDefect(repairedErrors))
    ) {
      throw new PlanAuthorityError("unresolved", `PLAN.md could not be safely repaired: ${repairedErrors.join("; ")}`, [plan.path]);
    }
    recordLifecycleEvent(workspace, {
      event: "plan_repaired",
      issueNumber,
      runId: options.runId || "unknown",
      outcome: "recovered",
      reasonCode: "plan_repaired",
      repair: { paths: [plan.path], fields: repair.fields },
    });
    return;
  }
  const errors = validatePlan(contents);
  if (
    errors.length &&
    !options.allowSemantic &&
    !(options.allowTaskMetadata && isPlanTaskMetadataDefect(errors))
  ) {
    throw new PlanAuthorityError(
      "unresolved",
      `PLAN.md contains unsafe or ambiguous structure and cannot be safely repaired: ${errors.join("; ")}`,
      [plan.path],
    );
  }
}

/** Rebuild only missing semantic sections from one live authority snapshot. */
export async function reconcileWorkspacePlan(
  workspace: string,
  issueNumber: number,
  options: { runId?: string; authority?: WorkAuthorityAdapter } = {},
): Promise<void> {
  // First layer is synchronous and mechanical. It may leave semantic errors,
  // but it proves canonical ownership before any authority-backed rewrite.
  try {
    validateWorkspacePlan(workspace, issueNumber, { ...options, allowSemantic: true });
  } catch (error) {
    if (!(error instanceof PlanAuthorityError) || error.code !== "unresolved") throw error;
  }

  const planPath = resolve(planFile(workspace));
  if (!existsSync(planPath)) return;
  const before = readFileSync(planPath, "utf8");
  if (!validatePlan(before).length) return;
  const live = await getLiveIssueFingerprint(workspace, issueNumber, options.authority);
  if (!live.acceptanceCriteria.length) {
    throw new PlanAuthorityError(
      "unresolved",
      `PLAN.md for issue #${issueNumber} is missing acceptance criteria and live authority provided none`,
      [planPath],
    );
  }

  let repaired = before;
  const fields: string[] = [];
  if (!/^\*\*Goal:\*\*/m.test(repaired)) {
    repaired = `**Goal:** ${live.title}\n\n${repaired}`;
    fields.push("goal");
  }
  const criteriaLines = live.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`);
  const existingSection = repaired.match(/(^##\s+Acceptance Criteria\s*$)([\s\S]*?)(?=^##\s+|$)/m);
  if (!existingSection) {
    repaired = `${repaired.replace(/\s*$/, "")}\n\n## Acceptance Criteria\n${criteriaLines.join("\n")}\n`;
    fields.push("acceptance criteria");
  } else {
    const existing = [...existingSection[2].matchAll(/^\s*- \[[ xX]\]\s+(.+?)\s*$/gm)]
      .map((match) => match[1].trim().toLowerCase());
    const missing = live.acceptanceCriteria.filter((criterion) => !existing.includes(criterion.trim().toLowerCase()));
    if (missing.length) {
      const end = (existingSection.index || 0) + existingSection[0].length;
      repaired = `${repaired.slice(0, end)}\n${missing.map((criterion) => `- [ ] ${criterion}`).join("\n")}${repaired.slice(end)}`;
      fields.push("acceptance criteria");
    }
  }
  const marker = `authority=${live.fingerprint}`;
  if (/^##\s+Log\s*$/m.test(repaired) && !repaired.includes(marker)) {
    repaired = `${repaired.replace(/\s*$/, "")}\n- Authority reconciliation ${marker}; live requirements merged.\n`;
    fields.push("log");
  }
  const temporary = `${planPath}.reconcile-${process.pid}`;
  try {
    writeFileSync(temporary, repaired, "utf8");
    renameSync(temporary, planPath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const remaining = validatePlan(readFileSync(planPath, "utf8"));
  if (remaining.length && !isPlanTaskMetadataDefect(remaining)) {
    throw new PlanAuthorityError(
      "unresolved",
      `PLAN.md could not be reconciled from live authority: ${remaining.join("; ")}`,
      [planPath],
    );
  }
  if (remaining.length) {
    // Missing task metadata is intentionally left for the planning-repair
    // worker. It has already passed canonical ownership and live-authority
    // reconciliation, so containing the issue here would make a ready issue
    // permanently ineligible before repository reasoning can occur.
    recordLifecycleEvent(workspace, {
      event: "plan_repair_requested",
      issueNumber,
      runId: options.runId || "unknown",
      outcome: "recovered",
      reasonCode: "plan_task_metadata_missing",
      repair: { paths: [planPath], fields: ["task metadata"] },
    });
    return;
  }
  recordLifecycleEvent(workspace, {
    event: "plan_reconciled",
    issueNumber,
    runId: options.runId || "unknown",
    outcome: "recovered",
    reasonCode: "plan_reconciled",
    repair: { paths: [planPath], fields, authorityFingerprint: live.fingerprint },
  });
}

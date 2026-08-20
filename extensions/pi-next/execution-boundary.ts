import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { issueWorkspaceIdentity, parseLeaseFromAuthority } from "./issue-leases.ts";
import type { LoopState } from "./loop-state.ts";
import { validatePlan } from "./plan.ts";
import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import { workflowArtifacts } from "./plan-read.ts";
import { PlanAuthorityError, resolvePlanIdentity } from "./util-core.ts";

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
  const repairable = new Set(["Missing # Plan:", "Missing ## Log"]);
  if (errors.some((error) => !repairable.has(error))) return undefined;

  let repaired = plan;
  const fields: string[] = [];
  if (errors.includes("Missing # Plan:")) {
    repaired = `# Plan: Issue #${issueNumber}\n\n${repaired}`;
    fields.push("title");
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

export function validateWorkspacePlan(
  workspace: string,
  issueNumber: number,
  options: { runId?: string } = {},
): void {
  const artifacts = workflowArtifacts(workspace);
  const invalidArtifacts = artifacts.filter(
    (artifact) => artifact.issueNumber !== issueNumber,
  );
  if (invalidArtifacts.length) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace contains a foreign or malformed workflow artifact: ${invalidArtifacts.map((artifact) => artifact.path).join(", ")}`,
      invalidArtifacts.map((artifact) => artifact.path),
    );
  }
  const plans = artifacts.filter((artifact) => artifact.kind === "plan");
  if (plans.length > 1) {
    throw new PlanAuthorityError(
      "ambiguous",
      "Multiple PLAN artifacts require explicit authority reconciliation before resume",
      plans.map((artifact) => artifact.path),
    );
  }

  const plan = resolvePlanIdentity(workspace);
  if (plan.kind === "unresolved" || plan.kind === "ambiguous") {
    throw new PlanAuthorityError(plan.kind, plan.reason, plan.paths);
  }
  if (plan.kind === "resolved" && plan.issueNumber !== issueNumber) {
    throw new PlanAuthorityError(
      "unowned",
      `Active workspace PLAN resolves to issue #${plan.issueNumber}, not #${issueNumber}`,
      [plan.path],
    );
  }
  if (plan.kind === "resolved" && plan.provenance !== "canonical") {
    throw new PlanAuthorityError(
      "unowned",
      "Legacy issue-scoped PLAN artifacts require explicit authority reconciliation before resume",
      [plan.path],
    );
  }
  if (plan.kind === "resolved") {
    const contents = readFileSync(plan.path, "utf8");
    const repair = repairPlanStructure(plan.path, contents, issueNumber);
    if (repair) {
      const repairedErrors = validatePlan(readFileSync(plan.path, "utf8"));
      if (repairedErrors.length) {
        throw new PlanAuthorityError(
          "unresolved",
          `PLAN.md could not be safely repaired: ${repairedErrors.join("; ")}`,
          [plan.path],
        );
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
    if (errors.length) {
      throw new PlanAuthorityError(
        "unresolved",
        `PLAN.md contains unsafe or ambiguous structure and cannot be safely repaired: ${errors.join("; ")}`,
        [plan.path],
      );
    }
  }
}

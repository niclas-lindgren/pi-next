import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { issueWorkspaceIdentity, parseLeaseFromAuthority } from "./issue-leases.ts";
import type { LoopState } from "./loop-state.ts";
import { validatePlan } from "./plan.ts";
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
export function validateWorkspacePlan(workspace: string, issueNumber: number): void {
  const artifacts = workflowArtifacts(workspace);
  const invalidArtifacts = artifacts.filter(
    (artifact) => artifact.issueNumber !== issueNumber,
  );
  if (invalidArtifacts.length) {
    throw new PlanAuthorityError(
      "unowned",
      `Issue #${issueNumber} workspace contains a foreign or malformed workflow artifact`,
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
    const errors = validatePlan(readFileSync(plan.path, "utf8"));
    if (errors.length) {
      throw new PlanAuthorityError(
        "unresolved",
        `PLAN.md is malformed and cannot be resumed: ${errors.join("; ")}`,
        [plan.path],
      );
    }
  }
}

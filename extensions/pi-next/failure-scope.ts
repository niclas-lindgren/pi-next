import { resolve } from "node:path";

import { issueWorkspaceIdentity } from "./issue-authority.ts";
import { PlanAuthorityError } from "./util-core.ts";
import { WorktreeRecoveryError } from "./issue-leases.ts";

export type IssueFailureStage =
  | "claim"
  | "worktree-handoff"
  | "workspace-validation"
  | "resume"
  | "execution"
  | "finalization";

export type FailureScope = "issue-local" | "loop-global";

export interface FailureScopeContext {
  stage: IssueFailureStage;
  issueNumber?: number;
  workspace?: string;
  coordinationCwd?: string;
  /** Ownership has been reconciled against the shared authority. */
  ownershipProven?: boolean;
}

export interface FailureClassification {
  scope: FailureScope;
  stage: IssueFailureStage;
  issueNumber?: number;
  code: string;
  paths: string[];
  reason: string;
}

/** A handoff error retains typed issue context while crossing the controller boundary. */
export class IssueBoundaryFailure extends Error {
  readonly code = "issue_boundary_unsafe";
  readonly paths: string[];
  constructor(
    readonly issueNumber: number,
    readonly stage: IssueFailureStage,
    readonly reason: string,
    paths: string[] = [],
  ) {
    super(`Issue #${issueNumber} boundary is unsafe: ${reason}`);
    this.name = "IssueBoundaryFailure";
    this.paths = paths;
  }
}

export class IssueHandoffError extends Error {
  readonly code = "issue_handoff_failed";
  readonly issueNumber: number;
  readonly stage: "worktree-handoff" | "workspace-validation" | "resume";
  readonly workspace?: string;
  readonly lease?: unknown;
  readonly leaseReleased: boolean;
  readonly ownershipProven: boolean;
  readonly paths: string[];
  readonly cause: unknown;

  constructor(input: {
    issueNumber: number;
    stage: "worktree-handoff" | "workspace-validation" | "resume";
    workspace?: string;
    lease?: unknown;
    leaseReleased?: boolean;
    ownershipProven?: boolean;
    paths?: string[];
    cause: unknown;
  }) {
    const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Issue #${input.issueNumber} ${input.stage} failed: ${detail}`);
    this.name = "IssueHandoffError";
    this.issueNumber = input.issueNumber;
    this.stage = input.stage;
    this.workspace = input.workspace;
    this.lease = input.lease;
    this.leaseReleased = input.leaseReleased ?? false;
    this.ownershipProven = input.ownershipProven ?? false;
    this.paths = input.paths ?? (input.cause instanceof PlanAuthorityError ? input.cause.paths : []);
    this.cause = input.cause;
  }
}

function isCanonicalWorkspace(context: FailureScopeContext): boolean {
  if (!context.issueNumber || !context.workspace || !context.coordinationCwd) return false;
  return resolve(context.workspace) === resolve(
    context.coordinationCwd,
    issueWorkspaceIdentity(context.issueNumber).worktree,
  );
}

/**
 * Classify only typed, issue-attributed failures as local. Unknown exceptions,
 * candidate selection errors, and authority/ownership failures stay global.
 * This is intentionally not based on diagnostic text.
 */
export function classifyFailure(
  error: unknown,
  context: FailureScopeContext,
): FailureClassification {
  if (error instanceof IssueBoundaryFailure &&
      context.issueNumber === error.issueNumber &&
      context.ownershipProven !== false) {
    return {
      scope: "issue-local",
      stage: error.stage,
      issueNumber: error.issueNumber,
      code: error.code,
      paths: error.paths,
      reason: error.message,
    };
  }

  if (error instanceof IssueHandoffError) {
    return {
      scope: error.leaseReleased || error.ownershipProven ? "issue-local" : "loop-global",
      stage: error.stage,
      issueNumber: error.issueNumber,
      code: error.code,
      paths: error.paths,
      reason: error.message,
    };
  }

  if (error instanceof WorktreeRecoveryError &&
      context.issueNumber === error.issueNumber &&
      context.ownershipProven !== false) {
    return {
      scope: "issue-local",
      stage: context.stage === "claim" ? "worktree-handoff" : context.stage,
      issueNumber: error.issueNumber,
      code: error.code,
      paths: context.workspace ? [context.workspace] : [],
      reason: error.message,
    };
  }

  if (error instanceof PlanAuthorityError &&
      context.issueNumber &&
      context.ownershipProven !== false &&
      isCanonicalWorkspace(context)) {
    return {
      scope: "issue-local",
      stage: context.stage,
      issueNumber: context.issueNumber,
      code: `plan_${error.code}`,
      paths: error.paths,
      reason: error.message,
    };
  }

  return {
    scope: "loop-global",
    stage: context.stage,
    issueNumber: context.issueNumber,
    code: "controller_integrity_failure",
    paths: [],
    reason: error instanceof Error ? error.message : String(error),
  };
}

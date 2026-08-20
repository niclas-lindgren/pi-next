/**
 * Harness-agnostic issue ownership contract.
 *
 * The lease is a record that can be stored in an authoritative shared
 * backend (the GitHub-backed lease ref in the claim implementation). Local
 * PLAN/runtime files may cache this shape, but never establish ownership.
 *
 * This module holds only the shared shapes/constants used by
 * `issue-authority.ts` (pure CAS/freshness/branch/worktree derivation) and
 * `issue-leases.ts` (claim/renew/heartbeat/release orchestration) so both
 * can be consumed independently of any specific agent harness.
 */

export const ISSUE_AUTHORITY_VERSION = 1 as const;
export const ISSUE_WORKTREE_ROOT = ".worktrees" as const;
export const ISSUE_LEASE_REF_PREFIX = "refs/leases/issues" as const;

export type AgentHarness = "pi-next" | "claude" | "ps-next" | (string & {});

export interface IssueWorkspaceIdentity {
  issueNumber: number;
  branch: string;
  worktree: string;
}

export interface IssueLease {
  version: typeof ISSUE_AUTHORITY_VERSION;
  issueNumber: number;
  agent: AgentHarness;
  runId: string;
  sessionId: string;
  branch: string;
  worktree: string;
  acquiredAt: string;
  expiresAt: string;
}

export type IssueLifecycleEventName =
  | "claim_acquired"
  | "claim_rejected"
  | "claim_released"
  | "claim_expired"
  | "claim_taken_over"
  | "legacy_branch_adopted"
  | "legacy_worktree_salvage_started"
  | "legacy_worktree_salvaged"
  | "legacy_worktree_adoption_authority_checked"
  | "legacy_worktree_migrated"
  | "project_status_sync_attempted"
  | "project_status_sync_failed"
  | "project_status_synced";

export interface IssueLifecycleEvent {
  version: typeof ISSUE_AUTHORITY_VERSION;
  event: IssueLifecycleEventName;
  issueNumber: number;
  agent?: AgentHarness;
  runId: string;
  branch: string;
  worktree: string;
  at: string;
  outcome: "success" | "failure" | "rejected" | "recovered";
  reasonCode?: string;
}

/**
 * Optional harness-supplied hook so `issue-leases.ts` can report
 * claim/release/takeover/worktree-adoption/project-status-sync events
 * without depending on any specific harness's telemetry storage (#588).
 * Pi supplies `.pi/extensions/pi-next/lifecycle-telemetry.ts#recordLifecycleEvent`;
 * other harnesses may supply their own recorder or omit it entirely.
 */
export type IssueLifecycleRecorder = (
  cwd: string,
  event: Omit<IssueLifecycleEvent, "version" | "at">,
) => void;

export type ProjectStatus = "Todo" | "In Progress" | "Done" | "Blocked";

/**
 * Authority-neutral evidence supplied by a consumer when implementation is
 * safe to integrate but one or more explicitly classified post-integration
 * checks remain. The kernel preserves these values verbatim; it does not
 * infer whether a criterion is safe to defer.
 */
export interface PendingVerificationCriterion {
  id: string;
  criterion: string;
  classification: string;
  environment: string;
  evidence?: string;
}

export interface PendingVerificationRequest {
  status: "awaiting_external_verification";
  criteria: readonly PendingVerificationCriterion[];
}

export interface PendingVerificationRecord extends PendingVerificationRequest {
  version: 1;
  issueNumber: number;
  integratedMainCommitSha: string;
}

/** GitHub-backed implementations must make this operation retryable/observable. */
export interface ProjectStatusAuthority {
  set(issueNumber: number, status: ProjectStatus): Promise<void>;
}

export class ProjectStatusSyncError extends Error {
  readonly code = "project_status_sync_failed";
  constructor(
    readonly issueNumber: number,
    readonly status: ProjectStatus,
    cause: unknown,
  ) {
    super(
      `Could not synchronize issue #${issueNumber} to Project status ${status}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ProjectStatusSyncError";
  }
}

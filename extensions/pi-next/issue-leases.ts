/**
 * Issue lease claim/renew/heartbeat/release orchestration and canonical
 * worktree attach/recreate logic.
 *
 * The harness-neutral core now lives in
 * `.agents/coordination/issue-leases.ts` (#588) so any agent harness can
 * share the same lease lifecycle and worktree derivation. This file
 * remains a thin re-export so every existing pi-next import path keeps
 * working unchanged and behavior is preserved exactly.
 */
export {
  GitHubIssueLeaseAuthority,
  LeaseConflictError,
  LeaseRecoveryError,
  ISSUE_LEASE_DURATION_MS,
  ISSUE_LEASE_HEARTBEAT_MS,
  claimIssueLease,
  renewIssueLease,
  startIssueLeaseHeartbeat,
  releaseIssueLease,
  recoverIssueLease,
  reconcileIssueLeaseForResume,
  WorktreeRecoveryError,
  ensureIssueWorktree,
  serializeLeaseForAuthority,
  parseLeaseFromAuthority,
  issueWorkspaceIdentity,
} from "../../../.agents/coordination/issue-leases.ts";
export type {
  IssueLease,
  IssueLeaseAuthority,
  LeaseLifecycleOptions,
  IssueLeaseHeartbeatOptions,
  WorktreeRecoveryDetails,
} from "../../../.agents/coordination/issue-leases.ts";

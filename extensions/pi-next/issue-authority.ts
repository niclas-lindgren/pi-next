/**
 * Harness-agnostic issue ownership contract.
 *
 * The pure CAS/freshness/branch/worktree derivation logic now lives in
 * `.agents/coordination/issue-authority.ts` (#588) so it can be shared by
 * any agent harness instead of being pi-next-specific. This file remains a
 * thin re-export so every existing pi-next import path keeps working
 * unchanged and behavior is preserved exactly.
 */
export {
  ISSUE_AUTHORITY_VERSION,
  ISSUE_WORKTREE_ROOT,
  ISSUE_LEASE_REF_PREFIX,
  issueWorkspaceIdentity,
  issueLeaseRef,
  createIssueLease,
  isIssueLeaseFresh,
  issueLeaseMatchesOwner,
  serializeIssueLease,
  parseIssueLease,
} from "../../../.agents/coordination/issue-authority.ts";
export type {
  AgentHarness,
  IssueWorkspaceIdentity,
  IssueLease,
  IssueLifecycleEventName,
  IssueLifecycleEvent,
} from "../../../.agents/coordination/issue-authority.ts";

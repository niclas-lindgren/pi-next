/**
 * Harness-neutral issue lease compare-and-swap primitives.
 *
 * Shared by compatible agent harnesses to derive canonical branch/worktree
 * identity and validate lease freshness/shape without depending on a specific
 * extension host. Do not change derivation, validation, or serialization rules
 * here without updating every harness that depends on them.
 */

import {
  ISSUE_AUTHORITY_VERSION,
  ISSUE_WORKTREE_ROOT,
  ISSUE_LEASE_REF_PREFIX,
  type IssueLease,
  type IssueWorkspaceIdentity,
} from "./types.ts";

export {
  ISSUE_AUTHORITY_VERSION,
  ISSUE_WORKTREE_ROOT,
  ISSUE_LEASE_REF_PREFIX,
} from "./types.ts";
export type {
  AgentHarness,
  IssueWorkspaceIdentity,
  IssueLease,
  IssueLifecycleEventName,
  IssueLifecycleEvent,
} from "./types.ts";

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error("issueNumber must be a positive integer");
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function issueWorkspaceIdentity(issueNumber: number): IssueWorkspaceIdentity {
  assertIssueNumber(issueNumber);
  return {
    issueNumber,
    branch: `agent/issue-${issueNumber}`,
    worktree: `${ISSUE_WORKTREE_ROOT}/issue-${issueNumber}`,
  };
}

export function issueLeaseRef(issueNumber: number): string {
  assertIssueNumber(issueNumber);
  return `${ISSUE_LEASE_REF_PREFIX}/${issueNumber}`;
}

export function createIssueLease(input: {
  issueNumber: number;
  agent: IssueLease["agent"];
  runId: string;
  sessionId: string;
  acquiredAt: string;
  expiresAt: string;
}): IssueLease {
  const workspace = issueWorkspaceIdentity(input.issueNumber);
  assertNonEmpty(input.agent, "agent");
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.sessionId, "sessionId");
  const acquired = Date.parse(input.acquiredAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) {
    throw new Error("lease timestamps must be valid and expire after acquisition");
  }
  return {
    version: ISSUE_AUTHORITY_VERSION,
    ...workspace,
    agent: input.agent,
    runId: input.runId,
    sessionId: input.sessionId,
    acquiredAt: new Date(acquired).toISOString(),
    expiresAt: new Date(expires).toISOString(),
  };
}

export function isIssueLeaseFresh(lease: IssueLease, now = new Date()): boolean {
  return Date.parse(lease.expiresAt) > now.getTime();
}

/**
 * Compare persisted loop ownership with the authoritative lease identity.
 * Workspace paths and branches are derived from the issue, never trusted from
 * durable runtime state or PLAN metadata.
 */
export function issueLeaseMatchesOwner(
  lease: IssueLease,
  expected: Pick<IssueLease, "issueNumber" | "agent" | "runId" | "sessionId">,
): boolean {
  const workspace = issueWorkspaceIdentity(expected.issueNumber);
  return (
    lease.issueNumber === expected.issueNumber &&
    lease.agent === expected.agent &&
    lease.runId === expected.runId &&
    lease.sessionId === expected.sessionId &&
    lease.branch === workspace.branch &&
    lease.worktree === workspace.worktree
  );
}

export function serializeIssueLease(lease: IssueLease): string {
  const expected = issueWorkspaceIdentity(lease.issueNumber);
  if (lease.version !== ISSUE_AUTHORITY_VERSION || lease.branch !== expected.branch || lease.worktree !== expected.worktree) {
    throw new Error("lease workspace identity does not match its issue");
  }
  return `${JSON.stringify(lease)}\n`;
}

export function parseIssueLease(serialized: string): IssueLease {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("lease record is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("lease record must be an object");
  const candidate = value as Partial<IssueLease>;
  if (
    candidate.version !== ISSUE_AUTHORITY_VERSION ||
    typeof candidate.issueNumber !== "number" ||
    typeof candidate.agent !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.branch !== "string" ||
    typeof candidate.worktree !== "string" ||
    typeof candidate.acquiredAt !== "string" ||
    typeof candidate.expiresAt !== "string"
  ) throw new Error("lease record is missing required fields");
  const expected = issueWorkspaceIdentity(candidate.issueNumber);
  if (candidate.branch !== expected.branch || candidate.worktree !== expected.worktree) {
    throw new Error("lease workspace identity does not match its issue");
  }
  return createIssueLease(candidate as Parameters<typeof createIssueLease>[0]);
}

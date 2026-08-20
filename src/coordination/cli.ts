/**
 * Harness-neutral CLI surface over the issue coordination module.
 *
 * Ported from Campsty's `.agents/coordination/cli.ts` (#588, #619) so any
 * agent harness (or a human operator) gets a stable, structured way to
 * interact with the shared lease/worktree/finalize algorithm without
 * importing TypeScript modules directly. `status`/`claim`/`renew`/
 * `release`/`workspace`/`prepare`/`finalize` each print exactly one JSON
 * object to stdout and set the process exit code; there is no other stdout
 * output, so callers can always `JSON.parse()` it.
 *
 * This module is intentionally framework-agnostic (no direct `process.exit`
 * calls) so it can be unit-tested in-process; `bin.ts` is the thin
 * executable wrapper that calls `runCoordinationCli` and applies the exit
 * code.
 */

import { sep } from "node:path";

import {
  createIssueLease,
  issueLeaseRef,
  issueWorkspaceIdentity,
  type IssueLease,
} from "./issue-authority.ts";
import {
  claimIssueLease,
  ensureIssueWorktree,
  GitHubIssueLeaseAuthority,
  LeaseConflictError,
  LeaseRecoveryError,
  releaseIssueLease,
  renewIssueLease,
  WorktreeRecoveryError,
  ISSUE_LEASE_DURATION_MS,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import { finalizeIssue, FinalizeError } from "./finalize.ts";
import { loadPiNextConfig } from "./config.ts";
import { AuthorityCapabilityError, createWorkAuthority, type WorkAuthorityAdapter } from "./work-authority.ts";
import type { PendingVerificationRequest } from "./types.ts";

export type CoordinationCliCommand =
  | "status"
  | "claim"
  | "renew"
  | "release"
  | "workspace"
  | "prepare"
  | "finalize";

/**
 * Stable, documented error codes (see `docs/ARCHITECTURE.md`). Callers
 * should branch on `code`, never on `message` text.
 */
export type CoordinationCliErrorCode =
  | "LEASE_CONFLICT"
  | "LEASE_LOST"
  | "WORKSPACE_MISMATCH"
  | "UNSAFE_ROOT"
  | "STALE_AUTHORITY"
  | "INVALID_ARGS"
  | "CANDIDATE_STALE"
  | "ROOT_BUSY"
  | "PROMOTION_RACE"
  | "MISSING_AUTHORITY_EVIDENCE";

export type CoordinationCliErrorDetails = Record<string, string>;

export class CoordinationCliError extends Error {
  constructor(
    readonly code: CoordinationCliErrorCode,
    message: string,
    readonly details?: CoordinationCliErrorDetails,
  ) {
    super(message);
    this.name = "CoordinationCliError";
  }
}

export interface CoordinationCliSuccess {
  ok: true;
  command: CoordinationCliCommand;
  [key: string]: unknown;
}

export interface CoordinationCliFailure {
  ok: false;
  command: CoordinationCliCommand | "unknown";
  code: CoordinationCliErrorCode;
  message: string;
  details?: CoordinationCliErrorDetails;
}

export type CoordinationCliResult = CoordinationCliSuccess | CoordinationCliFailure;

interface ParsedFlags {
  issue?: number;
  agent?: string;
  run?: string;
  session?: string;
  cwd?: string;
  status?: "Todo" | "Blocked";
  durationMs?: number;
  candidate?: string;
  issueUpdatedAt?: string;
  authorityFingerprint?: string;
  verifiedIntegratedMain?: string;
  closeComment?: string;
  pendingVerification?: PendingVerificationRequest;
  pendingComment?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      return args[index];
    };
    switch (arg) {
      case "--issue": {
        const value = Number.parseInt(next() ?? "", 10);
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new CoordinationCliError("INVALID_ARGS", "--issue must be a positive integer");
        }
        flags.issue = value;
        break;
      }
      case "--agent":
        flags.agent = next();
        break;
      case "--run":
        flags.run = next();
        break;
      case "--session":
        flags.session = next();
        break;
      case "--cwd":
        flags.cwd = next();
        break;
      case "--status": {
        const value = next();
        if (value !== "Todo" && value !== "Blocked") {
          throw new CoordinationCliError("INVALID_ARGS", "--status must be Todo or Blocked");
        }
        flags.status = value;
        break;
      }
      case "--duration-ms": {
        const value = Number.parseInt(next() ?? "", 10);
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new CoordinationCliError("INVALID_ARGS", "--duration-ms must be a positive integer");
        }
        flags.durationMs = value;
        break;
      }
      case "--candidate":
        flags.candidate = next();
        break;
      case "--issue-updated-at":
        flags.issueUpdatedAt = next();
        break;
      case "--authority-fingerprint":
        flags.authorityFingerprint = next();
        break;
      case "--verified-integrated-main":
        flags.verifiedIntegratedMain = next();
        break;
      case "--close-comment":
        flags.closeComment = next();
        break;
      case "--pending-verification": {
        const value = next();
        try {
          flags.pendingVerification = JSON.parse(value ?? "") as PendingVerificationRequest;
        } catch {
          throw new CoordinationCliError("INVALID_ARGS", "--pending-verification must be valid JSON");
        }
        break;
      }
      case "--pending-comment":
        flags.pendingComment = next();
        break;
      default:
        throw new CoordinationCliError("INVALID_ARGS", `Unknown flag: ${arg}`);
    }
  }
  return flags;
}

function requireIssue(flags: ParsedFlags): number {
  if (flags.issue === undefined) {
    throw new CoordinationCliError("INVALID_ARGS", "--issue <number> is required");
  }
  return flags.issue;
}

function requireOwnerFlags(flags: ParsedFlags): { agent: string; run: string; session: string } {
  if (!flags.agent) throw new CoordinationCliError("INVALID_ARGS", "--agent <name> is required");
  if (!flags.run) throw new CoordinationCliError("INVALID_ARGS", "--run <id> is required");
  if (!flags.session) throw new CoordinationCliError("INVALID_ARGS", "--session <id> is required");
  return { agent: flags.agent, run: flags.run, session: flags.session };
}

/**
 * Guard against operating on the wrong git checkout: `--cwd` must not sit
 * inside another issue's canonical `.worktrees/issue-<n>` checkout when a
 * different issue number is requested. Running worktree/lease mutations
 * from inside a foreign issue's worktree risks corrupting that checkout.
 */
function assertSafeRoot(cwd: string, issueNumber: number): void {
  const segments = cwd.split(sep);
  for (const segment of segments) {
    const match = /^issue-(\d+)$/.exec(segment);
    if (match && Number.parseInt(match[1], 10) !== issueNumber) {
      throw new CoordinationCliError(
        "UNSAFE_ROOT",
        `Refusing to operate on issue #${issueNumber} from inside issue #${match[1]}'s worktree (${cwd})`,
      );
    }
  }
}

/**
 * A candidate lease used only to carry issueNumber/agent/runId/sessionId
 * into renew/release, which re-read the authoritative record themselves
 * and compare ownership; the timestamps here are placeholders.
 */
function ownerCandidate(issueNumber: number, agent: string, runId: string, sessionId: string): IssueLease {
  const now = new Date();
  return createIssueLease({
    issueNumber,
    agent,
    runId,
    sessionId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 1000).toISOString(),
  });
}

function leaseAuthorityFor(cwd: string): IssueLeaseAuthority {
  return new GitHubIssueLeaseAuthority(cwd);
}

function workAuthorityFor(cwd: string): WorkAuthorityAdapter {
  return createWorkAuthority(cwd, loadPiNextConfig(cwd));
}

async function runStatus(flags: ParsedFlags): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  const cwd = flags.cwd ?? process.cwd();
  const identity = issueWorkspaceIdentity(issueNumber);
  let lease: IssueLease | undefined;
  try {
    lease = await leaseAuthorityFor(cwd).read(issueNumber);
  } catch (error) {
    throw new CoordinationCliError(
      "STALE_AUTHORITY",
      `Unable to read lease authority for issue #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    ok: true,
    command: "status",
    issueNumber,
    ref: issueLeaseRef(issueNumber),
    workspace: identity,
    lease: lease ?? null,
    fresh: lease ? Date.parse(lease.expiresAt) > Date.now() : false,
  };
}

async function runClaim(
  flags: ParsedFlags,
  leaseAuthority?: IssueLeaseAuthority,
): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  const { agent, run, session } = requireOwnerFlags(flags);
  const cwd = flags.cwd ?? process.cwd();
  assertSafeRoot(cwd, issueNumber);
  const now = new Date();
  const durationMs = flags.durationMs ?? ISSUE_LEASE_DURATION_MS;
  try {
    const lease = await claimIssueLease(
      leaseAuthority ?? leaseAuthorityFor(cwd),
      {
        issueNumber,
        agent,
        runId: run,
        sessionId: session,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + durationMs).toISOString(),
      },
      now,
      { cwd },
    );
    return { ok: true, command: "claim", lease };
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      throw new CoordinationCliError("LEASE_CONFLICT", error.message);
    }
    if (error instanceof LeaseRecoveryError) {
      throw new CoordinationCliError("STALE_AUTHORITY", error.message);
    }
    throw error;
  }
}

async function runRenew(flags: ParsedFlags): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  const { agent, run, session } = requireOwnerFlags(flags);
  const cwd = flags.cwd ?? process.cwd();
  assertSafeRoot(cwd, issueNumber);
  const candidate = ownerCandidate(issueNumber, agent, run, session);
  try {
    const renewed = await renewIssueLease(leaseAuthorityFor(cwd), candidate, new Date(), flags.durationMs);
    return { ok: true, command: "renew", lease: renewed };
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      throw new CoordinationCliError("LEASE_LOST", error.message);
    }
    throw error;
  }
}

async function runRelease(flags: ParsedFlags): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  const { agent, run, session } = requireOwnerFlags(flags);
  const cwd = flags.cwd ?? process.cwd();
  assertSafeRoot(cwd, issueNumber);
  const candidate = ownerCandidate(issueNumber, agent, run, session);
  try {
    await releaseIssueLease(leaseAuthorityFor(cwd), candidate, { cwd, status: flags.status });
    return { ok: true, command: "release", issueNumber };
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      throw new CoordinationCliError("LEASE_LOST", error.message);
    }
    throw error;
  }
}

function runWorkspace(flags: ParsedFlags): CoordinationCliSuccess {
  const issueNumber = requireIssue(flags);
  return { ok: true, command: "workspace", workspace: issueWorkspaceIdentity(issueNumber) };
}

async function runPrepare(flags: ParsedFlags): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  requireOwnerFlags(flags);
  const cwd = flags.cwd ?? process.cwd();
  assertSafeRoot(cwd, issueNumber);
  const leaseAuthority = leaseAuthorityFor(cwd);
  const claimResult = await runClaim(flags, leaseAuthority);
  try {
    const worktree = await ensureIssueWorktree(cwd, issueNumber, undefined, {
      ownership: { lease: claimResult.lease as IssueLease, authority: leaseAuthority },
    });
    return { ok: true, command: "prepare", lease: claimResult.lease, worktree };
  } catch (error) {
    const handoffError = error instanceof WorktreeRecoveryError
      ? new CoordinationCliError("WORKSPACE_MISMATCH", error.message, error.details)
      : error;
    try {
      // The claimed lease is released through the same authority instance and
      // releaseIssueLease performs an owner check plus an expected-record CAS.
      await releaseIssueLease(leaseAuthority, claimResult.lease as IssueLease, { cwd });
    } catch (rollbackError) {
      const handoffMessage = handoffError instanceof Error ? handoffError.message : String(handoffError);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new CoordinationCliError(
        "STALE_AUTHORITY",
        `Worktree handoff failed for issue #${issueNumber}; lease rollback also failed: ${rollbackMessage}`,
        { handoffFailure: handoffMessage, rollbackFailure: rollbackMessage },
      );
    }
    throw handoffError;
  }
}

/**
 * Mechanically integrate the verified `agent/issue-N` candidate into `main`
 * and close the work item only if lease ownership and issue authority both
 * remain exactly what was verified. See `finalize.ts` for the full guarded
 * sequence; this wrapper only maps flags/errors and picks the configured
 * `WorkAuthorityAdapter` for the close/comment step.
 */
async function runFinalize(flags: ParsedFlags): Promise<CoordinationCliSuccess> {
  const issueNumber = requireIssue(flags);
  const { agent, run, session } = requireOwnerFlags(flags);
  const cwd = flags.cwd ?? process.cwd();
  assertSafeRoot(cwd, issueNumber);
  if (!flags.candidate) {
    throw new CoordinationCliError("INVALID_ARGS", "--candidate <sha> is required");
  }
  if (!flags.issueUpdatedAt) {
    throw new CoordinationCliError("INVALID_ARGS", "--issue-updated-at <iso-timestamp> is required");
  }
  if (!flags.authorityFingerprint) {
    throw new CoordinationCliError("INVALID_ARGS", "--authority-fingerprint <fingerprint> is required for authoritative completion");
  }
  try {
    const result = await finalizeIssue(leaseAuthorityFor(cwd), workAuthorityFor(cwd), {
      cwd,
      issueNumber,
      agent,
      runId: run,
      sessionId: session,
      candidateSha: flags.candidate,
      issueUpdatedAt: flags.issueUpdatedAt,
      verifiedAuthorityFingerprint: flags.authorityFingerprint,
      verifiedIntegratedMain: flags.verifiedIntegratedMain,
      closeComment: flags.closeComment,
      pendingVerification: flags.pendingVerification,
      pendingComment: flags.pendingComment,
    });
    return { ...result, command: "finalize" };
  } catch (error) {
    if (error instanceof FinalizeError) {
      throw new CoordinationCliError(error.code, error.message, error.details);
    }
    if (error instanceof AuthorityCapabilityError) {
      throw new CoordinationCliError("STALE_AUTHORITY", error.message);
    }
    throw error;
  }
}

/**
 * Run one coordination command and return its structured result. Never
 * throws: every failure (including CLI usage errors) is converted into a
 * `CoordinationCliFailure` with a stable `code`.
 */
export async function runCoordinationCli(argv: string[]): Promise<CoordinationCliResult> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "status":
        return await runStatus(parseFlags(rest));
      case "claim":
        return await runClaim(parseFlags(rest));
      case "renew":
        return await runRenew(parseFlags(rest));
      case "release":
        return await runRelease(parseFlags(rest));
      case "workspace":
        return runWorkspace(parseFlags(rest));
      case "prepare":
        return await runPrepare(parseFlags(rest));
      case "finalize":
        return await runFinalize(parseFlags(rest));
      default:
        throw new CoordinationCliError(
          "INVALID_ARGS",
          `Unknown command: ${command ?? "(none)"}. Expected one of: status, claim, renew, release, workspace, prepare, finalize`,
        );
    }
  } catch (error) {
    if (error instanceof CoordinationCliError) {
      return {
        ok: false,
        command: isCoordinationCliCommand(command) ? command : "unknown",
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      };
    }
    return {
      ok: false,
      command: isCoordinationCliCommand(command) ? command : "unknown",
      code: "STALE_AUTHORITY",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isCoordinationCliCommand(value: string | undefined): value is CoordinationCliCommand {
  return value === "status" || value === "claim" || value === "renew" || value === "release" || value === "workspace" || value === "prepare" || value === "finalize";
}

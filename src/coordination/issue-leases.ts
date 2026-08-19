/**
 * Harness-neutral issue lease claim/renew/heartbeat/release orchestration
 * and canonical worktree attach/recreate logic.
 *
 * Extracted from `.pi/extensions/pi-next/issue-leases.ts` (#588) so any
 * agent harness can share the same lease lifecycle and worktree derivation
 * instead of re-implementing it. Behavior (CAS via
 * `refs/leases/issues/<N>`, branch `agent/issue-<N>`, worktree
 * `.worktrees/issue-<N>`) is preserved exactly.
 *
 * Lifecycle telemetry storage is a harness-host concern (Pi persists it
 * under `.pi/runtime/pi-next-lifecycle.json`), so this module never imports
 * a specific harness's implementation. Callers may pass an
 * `IssueLifecycleRecorder` (see `types.ts`) through `LeaseLifecycleOptions`;
 * when omitted, events are simply not recorded — this module has no
 * telemetry side effect of its own.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createIssueLease,
  isIssueLeaseFresh,
  issueLeaseRef,
  issueWorkspaceIdentity,
  parseIssueLease,
  serializeIssueLease,
  issueLeaseMatchesOwner,
  type IssueLease,
} from "./issue-authority.ts";
import {
  type IssueLifecycleRecorder,
  type ProjectStatus,
  type ProjectStatusAuthority,
  ProjectStatusSyncError,
} from "./types.ts";

export type { IssueLease } from "./issue-authority.ts";
export type {
  IssueLifecycleRecorder,
  ProjectStatus,
  ProjectStatusAuthority,
} from "./types.ts";
export { ProjectStatusSyncError } from "./types.ts";

/**
 * Sync a lease transition to an injected Project-status authority, reporting
 * attempt/success/failure through the same optional lifecycle recorder used
 * for claim/release events. Harness-neutral: callers supply both the
 * authority (e.g. a GitHub Projects client) and, optionally, where events
 * get recorded.
 */
async function syncProjectStatus(
  cwd: string,
  authority: ProjectStatusAuthority,
  input: {
    issueNumber: number;
    status: ProjectStatus;
    runId: string;
    agent?: string;
    branch?: string;
    worktree?: string;
  },
  recordEvent?: IssueLifecycleRecorder,
): Promise<void> {
  recordEvent?.(cwd, {
    event: "project_status_sync_attempted",
    issueNumber: input.issueNumber,
    runId: input.runId,
    agent: input.agent,
    branch: input.branch ?? "",
    worktree: input.worktree ?? "",
    outcome: "success",
    reasonCode: input.status,
  });
  try {
    await authority.set(input.issueNumber, input.status);
  } catch (error) {
    recordEvent?.(cwd, {
      event: "project_status_sync_failed",
      issueNumber: input.issueNumber,
      runId: input.runId,
      agent: input.agent,
      branch: input.branch ?? "",
      worktree: input.worktree ?? "",
      outcome: "failure",
      reasonCode: "project_status_sync_failed",
    });
    throw new ProjectStatusSyncError(input.issueNumber, input.status, error);
  }
  recordEvent?.(cwd, {
    event: "project_status_synced",
    issueNumber: input.issueNumber,
    runId: input.runId,
    agent: input.agent,
    branch: input.branch ?? "",
    worktree: input.worktree ?? "",
    outcome: "success",
    reasonCode: input.status,
  });
}

const execFileAsync = promisify(execFile);

/**
 * The authority is deliberately injected: production uses a GitHub-backed
 * compare-and-swap implementation, while callers/tests can use any shared
 * store. A read-then-create API is not sufficient; create must be atomic.
 */
export interface IssueLeaseAuthority {
  read(issueNumber: number): Promise<IssueLease | undefined>;
  create(issueNumber: number, lease: IssueLease): Promise<void>;
  replace(
    issueNumber: number,
    expected: IssueLease,
    lease: IssueLease,
  ): Promise<void>;
  remove(issueNumber: number, expected: IssueLease): Promise<void>;
}

/**
 * GitHub is the shared lease store. Each issue ref points at a commit whose
 * tree contains the lease record. Updates are non-forced fast-forward
 * updates, so the exact commit observed by read() is the CAS revision: two
 * stale readers cannot both replace or release a lease. A blank record is a
 * tombstone; keeping and advancing the ref avoids a delete-then-create race.
 */
export class GitHubIssueLeaseAuthority implements IssueLeaseAuthority {
  private repository?: string;
  private readonly revisions = new WeakMap<IssueLease, string>();
  private readonly tombstones = new Map<number, string>();

  constructor(private readonly cwd = process.cwd()) {}

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  private async repo(): Promise<string> {
    if (!this.repository) {
      const { stdout } = await execFileAsync(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        {
          cwd: this.cwd,
          encoding: "utf8",
        },
      );
      this.repository = stdout.trim();
    }
    if (!this.repository)
      throw new Error("Unable to determine GitHub repository");
    return this.repository;
  }

  private async ref(issueNumber: number): Promise<{ sha: string } | undefined> {
    try {
      const value = await this.gh([
        `repos/${await this.repo()}/git/ref/${issueLeaseRef(issueNumber).replace(/^refs\//, "")}`,
        "--jq",
        ".object",
      ]);
      return JSON.parse(value) as { sha: string };
    } catch {
      return undefined;
    }
  }

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    const current = await this.ref(issueNumber);
    if (!current) {
      this.tombstones.delete(issueNumber);
      return undefined;
    }

    // The claim ref points to a commit, not directly to a blob. Resolve
    // lease.json at that exact commit so the returned lease can carry the
    // revision that must be used for a later CAS replace/remove.
    const value = await this.gh([
      `repos/${await this.repo()}/contents/lease.json?ref=${encodeURIComponent(current.sha)}`,
    ]);
    const payload = JSON.parse(value) as {
      content?: string;
      encoding?: string;
    };
    if (payload.encoding !== "base64") {
      throw new Error(`Unexpected lease encoding for issue #${issueNumber}`);
    }
    const decoded = Buffer.from(
      (payload.content || "").replace(/\s/g, ""),
      "base64",
    )
      .toString("utf8")
      .trim();
    if (!decoded) {
      this.tombstones.set(issueNumber, current.sha);
      return undefined;
    }

    const lease = parseIssueLease(decoded);
    if (lease.issueNumber !== issueNumber) {
      throw new Error(`Lease record issue mismatch for #${issueNumber}`);
    }
    this.tombstones.delete(issueNumber);
    this.revisions.set(lease, current.sha);
    return lease;
  }

  private async write(
    issueNumber: number,
    expectedSha: string | undefined,
    value: string,
    message: string,
  ): Promise<string> {
    const repository = await this.repo();
    const blob = JSON.parse(
      await this.gh([
        `repos/${repository}/git/blobs`,
        "--method",
        "POST",
        "-f",
        `content=${value}`,
        "-f",
        "encoding=utf-8",
      ]),
    ) as { sha: string };
    const baseSha =
      expectedSha ||
      (await this.gh([
        `repos/${repository}/git/ref/heads/main`,
        "--jq",
        ".object.sha",
      ]));
    const baseTree = await this.gh([
      `repos/${repository}/git/commits/${baseSha}`,
      "--jq",
      ".tree.sha",
    ]);
    const tree = JSON.parse(
      await this.gh([
        `repos/${repository}/git/trees`,
        "--method",
        "POST",
        "-f",
        `base_tree=${baseTree}`,
        "-f",
        "tree[][path]=lease.json",
        "-f",
        "tree[][mode]=100644",
        "-f",
        "tree[][type]=blob",
        "-f",
        `tree[][sha]=${blob.sha}`,
      ]),
    ) as { sha: string };
    const commit = JSON.parse(
      await this.gh([
        `repos/${repository}/git/commits`,
        "--method",
        "POST",
        "-f",
        `message=${message}`,
        "-f",
        `tree=${tree.sha}`,
        "-f",
        `parents[]=${baseSha}`,
      ]),
    ) as { sha: string };
    const ref = issueLeaseRef(issueNumber).replace(/^refs\//, "");
    if (!expectedSha) {
      await this.gh([
        `repos/${repository}/git/refs`,
        "--method",
        "POST",
        "-f",
        `ref=${issueLeaseRef(issueNumber)}`,
        "-f",
        `sha=${commit.sha}`,
      ]);
    } else {
      // force=false makes this a compare-and-swap against expectedSha because
      // commit is a direct child of that exact observed revision. If another
      // claimant advanced the ref first, this update is no longer fast-forward.
      await this.gh([
        `repos/${repository}/git/refs/${ref}`,
        "--method",
        "PATCH",
        "-f",
        `sha=${commit.sha}`,
        "-F",
        "force=false",
      ]);
    }
    return commit.sha;
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    const current = await this.ref(issueNumber);
    if (current) {
      const tombstoneRevision = this.tombstones.get(issueNumber);
      if (!tombstoneRevision || tombstoneRevision !== current.sha) {
        throw new Error("lease already exists");
      }
      const revision = await this.write(
        issueNumber,
        tombstoneRevision,
        serializeIssueLease(lease),
        `claim issue #${issueNumber}`,
      );
      this.tombstones.delete(issueNumber);
      this.revisions.set(lease, revision);
      return;
    }
    const revision = await this.write(
      issueNumber,
      undefined,
      serializeIssueLease(lease),
      `claim issue #${issueNumber}`,
    );
    this.revisions.set(lease, revision);
  }

  async replace(
    issueNumber: number,
    expected: IssueLease,
    lease: IssueLease,
  ): Promise<void> {
    const expectedSha = this.revisions.get(expected);
    if (!expectedSha) throw new Error("lease revision unavailable");
    const revision = await this.write(
      issueNumber,
      expectedSha,
      serializeIssueLease(lease),
      `take over issue #${issueNumber}`,
    );
    this.revisions.set(lease, revision);
  }

  async remove(issueNumber: number, expected: IssueLease): Promise<void> {
    const expectedSha = this.revisions.get(expected);
    if (!expectedSha) throw new Error("lease revision unavailable");
    const revision = await this.write(
      issueNumber,
      expectedSha,
      "",
      `release issue #${issueNumber}`,
    );
    this.tombstones.set(issueNumber, revision);
  }
}

export class LeaseConflictError extends Error {
  readonly code = "lease_conflict";
  readonly reasonCode = "fresh_owner";
  constructor(issueNumber: number) {
    super(`Issue #${issueNumber} is already leased by a fresh owner`);
    this.name = "LeaseConflictError";
  }
}

export class LeaseRecoveryError extends Error {
  readonly code = "lease_recovery_failed";
  constructor(
    readonly issueNumber: number,
    readonly operation: "read" | "takeover" | "claim",
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Issue #${issueNumber} lease ${operation} failed: ${detail}`);
    this.name = "LeaseRecoveryError";
  }
}

export interface LeaseLifecycleOptions {
  cwd?: string;
  projectStatus?: ProjectStatusAuthority;
  recordEvent?: IssueLifecycleRecorder;
}

const MAX_CLAIM_ATTEMPTS = 3;
export const ISSUE_LEASE_DURATION_MS = 30 * 60_000;
export const ISSUE_LEASE_HEARTBEAT_MS = 10 * 60_000;

export async function claimIssueLease(
  authority: IssueLeaseAuthority,
  input: Parameters<typeof createIssueLease>[0],
  now = new Date(),
  options: LeaseLifecycleOptions = {},
): Promise<IssueLease> {
  const lease = createIssueLease(input);
  let current: IssueLease | undefined;
  let claimed = false;
  let tookOver = false;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      current = await authority.read(input.issueNumber);
    } catch (error) {
      throw new LeaseRecoveryError(input.issueNumber, "read", error);
    }
    if (current && isIssueLeaseFresh(current, now)) {
      if (options.cwd)
        options.recordEvent?.(options.cwd, {
          event: "claim_rejected",
          issueNumber: input.issueNumber,
          runId: input.runId,
          agent: input.agent,
          branch: lease.branch,
          worktree: lease.worktree,
          outcome: "rejected",
          reasonCode: "fresh_owner",
        });
      throw new LeaseConflictError(input.issueNumber);
    }
    try {
      if (current) {
        await authority.replace(input.issueNumber, current, lease);
        tookOver = true;
      } else {
        await authority.create(input.issueNumber, lease);
      }
      claimed = true;
      break;
    } catch (error) {
      // A failed stale CAS is not proof of a fresh conflict. Re-read the
      // authority before classifying it, then retry only while it remains
      // stale/absent. This also handles a create race without stale claims.
      let observed: IssueLease | undefined;
      try {
        observed = await authority.read(input.issueNumber);
      } catch (readError) {
        throw new LeaseRecoveryError(
          input.issueNumber,
          current ? "takeover" : "claim",
          readError,
        );
      }
      if (observed && isIssueLeaseFresh(observed, now)) {
        throw new LeaseConflictError(input.issueNumber);
      }
      if (attempt === MAX_CLAIM_ATTEMPTS - 1) {
        throw new LeaseRecoveryError(
          input.issueNumber,
          current ? "takeover" : "claim",
          error,
        );
      }
    }
  }
  if (!claimed) {
    throw new LeaseRecoveryError(
      input.issueNumber,
      "claim",
      "claim did not establish authority",
    );
  }
  if (options.cwd)
    options.recordEvent?.(options.cwd, {
      event: tookOver ? "claim_taken_over" : "claim_acquired",
      issueNumber: lease.issueNumber,
      runId: lease.runId,
      agent: lease.agent,
      branch: lease.branch,
      worktree: lease.worktree,
      outcome: tookOver ? "recovered" : "success",
    });
  if (options.cwd && options.projectStatus) {
    await syncProjectStatus(
      options.cwd,
      options.projectStatus,
      {
        issueNumber: lease.issueNumber,
        status: "In Progress",
        runId: lease.runId,
        agent: lease.agent,
        branch: lease.branch,
        worktree: lease.worktree,
      },
      options.recordEvent,
    );
  }
  return lease;
}

export async function renewIssueLease(
  authority: IssueLeaseAuthority,
  lease: IssueLease,
  now = new Date(),
  durationMs = ISSUE_LEASE_DURATION_MS,
): Promise<IssueLease> {
  const current = await authority.read(lease.issueNumber);
  if (
    !current ||
    current.runId !== lease.runId ||
    current.sessionId !== lease.sessionId
  ) {
    throw new LeaseConflictError(lease.issueNumber);
  }
  const renewed = createIssueLease({
    ...current,
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
  });
  await authority.replace(lease.issueNumber, current, renewed);
  return renewed;
}

export interface IssueLeaseHeartbeatOptions {
  intervalMs?: number;
  durationMs?: number;
  onRenew?: (lease: IssueLease) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * When provided, the heartbeat stops itself as soon as this signal
   * aborts (e.g. its owning extension generation was torn down/replaced,
   * #583) instead of waiting for the caller to notice and call `stop()`.
   * A stopped heartbeat can never renew and overwrite a newer owner's
   * lease.
   */
  signal?: AbortSignal;
}

/** Keep a live owner fresh; a lost owner stops trying rather than reclaiming. */
export function startIssueLeaseHeartbeat(
  authority: IssueLeaseAuthority,
  initialLease: IssueLease,
  options: IssueLeaseHeartbeatOptions = {},
): { getLease: () => IssueLease; stop: () => Promise<void> } {
  let current = initialLease;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const intervalMs = options.intervalMs ?? ISSUE_LEASE_HEARTBEAT_MS;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        current = await renewIssueLease(
          authority,
          current,
          new Date(),
          options.durationMs,
        );
        await options.onRenew?.(current);
      } catch (error) {
        stopped = true;
        // Heartbeats run from an unawaited interval callback. Notification or
        // telemetry hooks are extension-host code and may themselves fail
        // while a session is being torn down; never let that rejection escape
        // into the host as an unhandled rejection.
        try {
          await options.onError?.(error);
        } catch {
          // The lease is already stopped; the original renewal error remains
          // the actionable failure and cleanup can continue safely.
        }
      } finally {
        inFlight = undefined;
      }
    })();
    try {
      await inFlight;
    } catch {
      // Keep the timer boundary rejection-safe even if future heartbeat
      // changes add an error path outside the guarded renewal block.
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
  if (options.signal) {
    // A disposed generation must stop heartbeating immediately so it can
    // never renew/overwrite a newer owner's lease after teardown (#583).
    const onAbort = () => {
      void stop();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    getLease: () => current,
    stop,
  };
}

export async function releaseIssueLease(
  authority: IssueLeaseAuthority,
  lease: IssueLease,
  options: LeaseLifecycleOptions & { status?: "Todo" | "Blocked" } = {},
): Promise<void> {
  const current = await authority.read(lease.issueNumber);
  if (!current) return;
  if (!issueLeaseMatchesOwner(current, lease)) {
    throw new LeaseConflictError(lease.issueNumber);
  }
  await authority.remove(lease.issueNumber, current);
  if (options.cwd)
    options.recordEvent?.(options.cwd, {
      event: "claim_released",
      issueNumber: lease.issueNumber,
      runId: lease.runId,
      agent: lease.agent,
      branch: lease.branch,
      worktree: lease.worktree,
      outcome: "success",
    });
  if (options.cwd && options.projectStatus) {
    await syncProjectStatus(
      options.cwd,
      options.projectStatus,
      {
        issueNumber: lease.issueNumber,
        status: options.status || "Todo",
        runId: lease.runId,
        agent: lease.agent,
        branch: lease.branch,
        worktree: lease.worktree,
      },
      options.recordEvent,
    );
  }
}

export async function recoverIssueLease(
  authority: IssueLeaseAuthority,
  input: Parameters<typeof createIssueLease>[0],
  now = new Date(),
): Promise<IssueLease> {
  const current = await authority.read(input.issueNumber);
  if (current && isIssueLeaseFresh(current, now))
    throw new LeaseConflictError(input.issueNumber);
  return claimIssueLease(authority, input, now);
}

/**
 * Reconcile durable loop ownership before a resumed prompt. A fresh lease
 * must still belong to the exact persisted Pi run; a stale lease is recovered
 * through the existing compare-and-swap takeover path. Missing authority is
 * never inferred from loop state or a PLAN artifact.
 */
export async function reconcileIssueLeaseForResume(
  authority: IssueLeaseAuthority,
  expected: IssueLease,
  now = new Date(),
): Promise<IssueLease> {
  let current: IssueLease | undefined;
  try {
    current = await authority.read(expected.issueNumber);
  } catch (error) {
    throw new LeaseRecoveryError(expected.issueNumber, "read", error);
  }
  if (!current) {
    throw new LeaseRecoveryError(
      expected.issueNumber,
      "read",
      new Error("active loop lease is missing; refusing resume"),
    );
  }
  if (isIssueLeaseFresh(current, now)) {
    if (!issueLeaseMatchesOwner(current, expected)) {
      throw new LeaseConflictError(expected.issueNumber);
    }
    return current;
  }
  return recoverIssueLease(
    authority,
    {
      issueNumber: expected.issueNumber,
      agent: expected.agent,
      runId: expected.runId,
      sessionId: expected.sessionId,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ISSUE_LEASE_DURATION_MS).toISOString(),
    },
    now,
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

export type WorktreeRecoveryDetails = Record<string, string>;

export class WorktreeRecoveryError extends Error {
  readonly code = "worktree_recovery_failed";
  constructor(
    readonly issueNumber: number,
    readonly operation: "inspect" | "prune" | "fetch" | "branch" | "attach" | "migrate",
    cause: unknown,
    readonly details: WorktreeRecoveryDetails = {},
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Issue #${issueNumber} worktree ${operation} failed: ${detail}`);
    this.name = "WorktreeRecoveryError";
    this.cause = cause;
  }
}

const LEGACY_BRANCH_PATTERN = /^pi-next\/issue-(\d+)\/([^/]+)$/;

function isLegacyIssueBranch(branch: string, issueNumber: number): boolean {
  const match = LEGACY_BRANCH_PATTERN.exec(branch);
  return match !== null && Number.parseInt(match[1], 10) === issueNumber;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["show-ref", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
}

async function refTip(cwd: string, ref: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "--verify", ref]).catch(() => undefined);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])
    .then(() => true)
    .catch(() => false);
}

async function authoritativeMain(cwd: string): Promise<string | undefined> {
  return (
    (await refTip(cwd, "refs/remotes/origin/main")) ??
    (await refTip(cwd, "refs/heads/main")) ??
    (await refTip(cwd, "HEAD"))
  );
}

/**
 * Look for exact legacy harness/run-shaped branches on origin for this issue.
 * Branch presence is only a migration input; it is never ownership authority.
 */
async function findLegacyIssueBranch(
  cwd: string,
  issueNumber: number,
): Promise<string | undefined> {
  try {
    const output = await git(cwd, [
      "ls-remote",
      "--heads",
      "origin",
      `pi-next/issue-${issueNumber}/*`,
    ]);
    const refs = output
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((ref): ref is string => Boolean(ref))
      .map((ref) => ref.replace(/^refs\/heads\//, ""))
      .filter((ref) => isLegacyIssueBranch(ref, issueNumber));
    if (refs.length === 0) return undefined;
    if (refs.length === 1) return refs[0];
    let newest: { ref: string; ts: number } | undefined;
    for (const ref of refs) {
      await git(cwd, [
        "fetch",
        "origin",
        `${ref}:refs/remotes/origin/${ref}`,
      ]).catch(() => undefined);
      const ts = await git(cwd, [
        "log",
        "-1",
        "--format=%ct",
        `refs/remotes/origin/${ref}`,
      ])
        .then((value) => Number.parseInt(value, 10))
        .catch(() => 0);
      if (!newest || ts > newest.ts) newest = { ref, ts };
    }
    return newest?.ref;
  } catch {
    return undefined;
  }
}

function preservationPath(path: string, tip: string): string {
  const parent = dirname(path);
  const stem = `${basename(path)}-legacy-${tip.slice(0, 12)}`;
  let candidate = resolve(parent, stem);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = resolve(parent, `${stem}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function migrateAttachedLegacyWorktree(
  cwd: string,
  issueNumber: number,
  path: string,
  legacyBranch: string,
  canonicalBranch: string,
  recordEvent?: IssueLifecycleRecorder,
): Promise<string> {
  if (!isLegacyIssueBranch(legacyBranch, issueNumber)) {
    throw new WorktreeRecoveryError(
      issueNumber,
      "attach",
      new Error(
        `canonical path is attached to ${legacyBranch || "a detached HEAD"}; expected ${canonicalBranch}`,
      ),
      { reason: "foreign_branch", attachedBranch: legacyBranch || "(detached)", expectedBranch: canonicalBranch },
    );
  }

  const legacyTip = await refTip(cwd, `refs/heads/${legacyBranch}`);
  if (!legacyTip) {
    throw new WorktreeRecoveryError(issueNumber, "inspect", new Error(`legacy branch ${legacyBranch} has no readable tip`), {
      reason: "legacy_tip_unreadable",
      legacyBranch,
    });
  }
  const canonicalTip = await refTip(cwd, `refs/heads/${canonicalBranch}`);
  const mainTip = await authoritativeMain(cwd);
  const dirty = Boolean(await git(path, ["status", "--porcelain=v1", "--untracked-files=all"]));
  const legacyBasedOnMain = mainTip ? await isAncestor(cwd, mainTip, legacyTip) : true;
  const legacyAheadOfCanonical = canonicalTip
    ? !(await isAncestor(cwd, legacyTip, canonicalTip))
    : false;
  const canonicalAheadOfLegacy = canonicalTip
    ? !(await isAncestor(cwd, canonicalTip, legacyTip))
    : false;

  const details: WorktreeRecoveryDetails = {
    reason: "legacy_migration",
    legacyBranch,
    legacyTip,
    canonicalBranch,
    ...(canonicalTip ? { canonicalTip } : {}),
    ...(mainTip ? { mainTip } : {}),
    dirty: String(dirty),
  };
  if (!legacyBasedOnMain) {
    throw new WorktreeRecoveryError(
      issueNumber,
      "migrate",
      new Error(`${legacyBranch} is not based on authoritative main`),
      { ...details, reason: "legacy_not_based_on_main" },
    );
  }
  if (canonicalTip && canonicalAheadOfLegacy && legacyAheadOfCanonical) {
    throw new WorktreeRecoveryError(
      issueNumber,
      "migrate",
      new Error(`legacy ${legacyBranch} and canonical ${canonicalBranch} branches diverge`),
      { ...details, reason: "diverged_branches" },
    );
  }

  const destination = dirty ? preservationPath(path, legacyTip) : undefined;
  try {
    if (dirty) {
      mkdirSync(dirname(destination!), { recursive: true });
      await git(cwd, ["worktree", "move", path, destination!]);
    } else {
      await git(cwd, ["worktree", "remove", path]);
    }
    if (!canonicalTip) {
      await git(cwd, ["branch", canonicalBranch, legacyTip]);
    } else if (await isAncestor(cwd, canonicalTip, legacyTip)) {
      // The canonical branch is only advanced after ancestry proves this is a
      // fast-forward. The old legacy ref and any preserved checkout remain.
      await git(cwd, [
        "update-ref",
        `refs/heads/${canonicalBranch}`,
        legacyTip,
        canonicalTip,
      ]);
    }
    await git(cwd, ["worktree", "add", path, canonicalBranch]);
    const attached = await git(path, ["branch", "--show-current"]);
    if (attached !== canonicalBranch) {
      throw new Error(`migrated path is attached to ${attached}; expected ${canonicalBranch}`);
    }
  } catch (error) {
    throw new WorktreeRecoveryError(issueNumber, "migrate", error, {
      ...details,
      ...(destination ? { preservedWorktree: destination } : {}),
    });
  }
  recordEvent?.(cwd, {
    event: "legacy_worktree_migrated",
    issueNumber,
    runId: `migrate-${Date.now()}`,
    branch: canonicalBranch,
    worktree: `.worktrees/issue-${issueNumber}`,
    outcome: "success",
    reasonCode: dirty ? "dirty_work_preserved" : "clean_legacy_worktree",
  });
  return path;
}

/** Attach/recreate the canonical issue worktree without changing its identity. */
export async function ensureIssueWorktree(
  cwd: string,
  issueNumber: number,
  recordEvent?: IssueLifecycleRecorder,
): Promise<string> {
  const identity = issueWorkspaceIdentity(issueNumber);
  const path = resolve(cwd, identity.worktree);
  const branch = identity.branch;
  try {
    const worktree = await git(cwd, ["worktree", "list", "--porcelain"]);
    if (
      worktree.split("\n").some((line) => line === `worktree ${path}`) &&
      existsSync(path)
    ) {
      let attachedBranch: string;
      try {
        attachedBranch = await git(path, ["branch", "--show-current"]);
      } catch (error) {
        throw new WorktreeRecoveryError(issueNumber, "inspect", error);
      }
      if (attachedBranch !== branch) {
        return migrateAttachedLegacyWorktree(cwd, issueNumber, path, attachedBranch, branch, recordEvent);
      }
      return path;
    }
    // A deleted checkout can remain registered in Git's worktree metadata. Prune
    // that stale registration before recreating the issue-owned checkout.
    if (worktree.split("\n").some((line) => line === `worktree ${path}`)) {
      await git(cwd, ["worktree", "prune"]);
    }
    mkdirSync(dirname(path), { recursive: true });
    const branchExists = await refExists(cwd, `refs/heads/${branch}`);
    if (!branchExists) {
      // Prefer a published issue checkpoint. If none exists, create from the
      // freshly fetched authoritative main, never from a harness worktree.
      const remoteExists = await git(cwd, [
        "ls-remote",
        "--exit-code",
        "origin",
        `refs/heads/${branch}`,
      ])
        .then(() => true)
        .catch(() => false);
      if (remoteExists) {
        await git(cwd, ["fetch", "origin", `${branch}:${branch}`]);
      } else {
        // Prefer adopting an already-fetched legacy harness/run-shaped branch's
        // accumulated work over discarding it and starting fresh from main.
        const legacyRef = await findLegacyIssueBranch(cwd, issueNumber);
        if (legacyRef) {
          await git(cwd, [
            "fetch",
            "origin",
            `${legacyRef}:refs/remotes/origin/${legacyRef}`,
          ]).catch(() => undefined);
          await git(cwd, [
            "branch",
            branch,
            `refs/remotes/origin/${legacyRef}`,
          ]);
          recordEvent?.(cwd, {
            event: "legacy_branch_adopted",
            issueNumber,
            runId: `adopt-${Date.now()}`,
            branch,
            worktree: identity.worktree,
            outcome: "success",
            reasonCode: legacyRef,
          });
        } else {
          await git(cwd, ["fetch", "origin", "main"]).catch(async () => {
            // Test/local repositories may have no remote; their checked-out main
            // is the authoritative baseline in that mode.
            const localMain = await git(cwd, [
              "show-ref",
              "--verify",
              "--quiet",
              "refs/heads/main",
            ])
              .then(() => "main")
              .catch(() => "HEAD");
            await git(cwd, ["branch", branch, localMain]);
          });
          if (!(await refExists(cwd, `refs/heads/${branch}`))) {
            await git(cwd, ["branch", branch, "refs/remotes/origin/main"]);
          }
        }
      }
    }
    await git(cwd, ["worktree", "add", path, branch]);
    return path;
  } catch (error) {
    if (error instanceof WorktreeRecoveryError) throw error;
    const operation =
      error instanceof Error && /worktree prune/.test(error.message)
        ? "prune"
        : error instanceof Error && /worktree add/.test(error.message)
          ? "attach"
          : "branch";
    throw new WorktreeRecoveryError(issueNumber, operation, error);
  }
}

export function serializeLeaseForAuthority(lease: IssueLease): string {
  return serializeIssueLease(lease);
}

export function parseLeaseFromAuthority(value: string): IssueLease {
  return parseIssueLease(value);
}

export { issueWorkspaceIdentity };

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadPiNextConfig, type PiNextConfig } from "../../src/coordination/config.ts";
import {
  createWorkAuthority,
  requireAuthorityCapability,
  isAwaitingExternalVerification,
  type AuthorityWorkItem,
  type WorkAuthorityAdapter,
} from "../../src/coordination/work-authority.ts";
import { psDir } from "./util.ts";
import type { IssueLeaseAuthority } from "./issue-leases.ts";
import { isIssueLeaseFresh } from "./issue-authority.ts";
import { refreshMainAtIssueBoundary } from "./main-refresh.ts";
import {
  authorityOperationTimeoutMs,
  withAuthorityTimeout,
} from "../../src/coordination/authority-read-policy.ts";

const PRIORITY_BUCKET_LIMITS = [3, 5, 3, 2] as const;
const ARCHIVED_SCAN_LIMIT = 200;
const DEFERRED_SCAN_LIMIT = 100;
export const DEFAULT_CANDIDATE_SELECTION_DEADLINE_MS = 60_000;
export const DEFAULT_LEASE_READ_WINDOW = 8;
export const DEFAULT_LEASE_READ_CONCURRENCY = 3;

interface CandidateIssue {
  number: number;
  title: string;
  updatedAt?: string;
  labels?: Array<{ name?: string }>;
}

export type CandidateShortlistOutcome = "candidate" | "exhausted" | "unavailable";

export type AuthorityEligibility =
  | "eligible"
  | "blocked"
  | "closed"
  | "deferred"
  | "not_ready"
  | "unavailable";

export interface AuthorityEligibilityResult {
  disposition: AuthorityEligibility;
  eligible: boolean;
  reason: string;
}

export interface CandidateShortlist {
  text?: string;
  exhausted: boolean;
  /** Explicitly distinguishes a verified empty queue from an unsafe query. */
  outcome: CandidateShortlistOutcome;
  /** The first candidate in configured priority order, when one exists. */
  candidateIssueNumber?: number;
  /** Eligible issues skipped by a bounded lease-read preflight because a fresh owner already holds them. */
  leasedElsewhereIssues?: number[];
  reason?: string;
}

/** Discovery failures must not be mistaken for an empty authoritative queue. */
export class CandidateDiscoveryError extends Error {
  readonly code = "candidate_discovery_unavailable";

  constructor(readonly reason: string) {
    super(`Candidate discovery unavailable: ${reason}`);
    this.name = "CandidateDiscoveryError";
  }
}

export interface CandidateShortlistOptions {
  completedIssues?: number[];
  deferredIssues?: number[];
  includeLocalArchiveExclusions?: boolean;
  /** Shared authority used to refresh ownership immediately before selection. */
  leaseAuthority?: IssueLeaseAuthority;
  /** Current-run candidate exclusions recorded by the scheduler, such as a fresh-owner race. */
  schedulerExcludedIssues?: number[];
  now?: Date;
  /** Reports slow authority/refresh phases to the interactive command UI. */
  onStatus?: (message: string) => void;
  /** Inject a project adapter; production resolves it from validated config. */
  authority?: WorkAuthorityAdapter;
  /** Use a validated configuration supplied by a host or test. */
  config?: PiNextConfig;
  /** Skip refreshing the shared coordination checkout when another agent owns its dirty state. */
  refreshMain?: boolean;
  /** Bounds each injected authority operation; production gh calls have their own process timeout. */
  authorityTimeoutMs?: number;
  /** Bounds the complete refresh/query/lease-selection phase. */
  selectionDeadlineMs?: number;
  /** Maximum number of lease reads inspected in one progressive window. */
  leaseReadWindow?: number;
  /** Maximum simultaneous lease reads. */
  leaseReadConcurrency?: number;
}

function labelNames(issue: Pick<CandidateIssue, "labels">): string[] {
  return (issue.labels || [])
    .map((label) => label.name || "")
    .filter(Boolean);
}

function stateMatches(states: readonly string[], wanted: string): boolean {
  const normalized = wanted.trim().toLowerCase();
  return states.some((state) => {
    const value = state.trim().toLowerCase();
    return value === normalized || value.replace(/^status:/, "") === normalized.replace(/^status:/, "");
  });
}

function candidateFromAuthority(item: AuthorityWorkItem): CandidateIssue | undefined {
  if (!Number.isSafeInteger(item.number) || (item.number || 0) < 1) return undefined;
  return {
    number: item.number!,
    title: item.title,
    updatedAt: item.updatedAt,
    labels: [
      ...item.states.map((name) => ({ name })),
      ...(item.priority ? [{ name: `priority: ${item.priority}` }] : []),
    ],
  };
}

/** Blocked issues require an explicit recovery/decision and are never an
 * autonomous candidate, even when they carry a higher priority label. */
export function isBlockedCandidate(
  issue: Pick<CandidateIssue, "labels">,
  blockedStates: readonly string[] = ["blocked"],
): boolean {
  return blockedStates.some((state) => stateMatches(labelNames(issue), state));
}

/**
 * Findings are backlog evidence, not autonomous work.  The labels/states are
 * configuration, so the kernel does not require a particular GitHub workflow;
 * an authority can map its own review state into these values.
 */
export function isHeldSelfAssessmentFinding(
  issue: Pick<CandidateIssue, "labels">,
  config: Pick<PiNextConfig, "assessment">,
): boolean {
  const labels = labelNames(issue);
  const isFinding = config.assessment.findingLabels.some((label) => stateMatches(labels, label));
  if (!isFinding) return false;
  const approved = config.assessment.approvedStates.some((state) => stateMatches(labels, state));
  if (approved) return false;
  return config.assessment.heldStates.some((state) => stateMatches(labels, state)) || isFinding;
}

/**
 * Classify live authority through the same policy used by candidate
 * selection. Active plans must use this result as an execution gate too;
 * lease ownership is deliberately not part of this classification.
 */
export function classifyAuthorityEligibility(
  item: AuthorityWorkItem,
  config: PiNextConfig,
): AuthorityEligibilityResult {
  const states = item.states || [];
  const state = item.state.trim().toLowerCase();
  if (state === "closed" || state === "done" || stateMatches(states, config.authority.projectStatus.done)) {
    return { disposition: "closed", eligible: false, reason: `authority is closed/done (${item.state || config.authority.projectStatus.done})` };
  }
  if (
    stateMatches(states, config.authority.projectStatus.blocked) ||
    isBlockedCandidate({ labels: states.map((name) => ({ name })) }, config.selection.blockedStates)
  ) {
    const blocker = states.find((value) =>
      stateMatches([value], config.authority.projectStatus.blocked) ||
      config.selection.blockedStates.some((wanted) => stateMatches([value], wanted)),
    );
    return { disposition: "blocked", eligible: false, reason: `authority is blocked${blocker ? ` (${blocker})` : ""}` };
  }
  const labels = states.map((name) => ({ name }));
  if (
    isAwaitingExternalVerification(item) ||
    isHeldSelfAssessmentFinding({ labels }, config)
  ) {
    return { disposition: "deferred", eligible: false, reason: "authority explicitly defers autonomous work" };
  }
  const explicitDeferred = ["deferred", "not-autonomous", "status:deferred", "status:not-autonomous"];
  const deferred = states.find((value) => explicitDeferred.some((wanted) => stateMatches([value], wanted)));
  if (deferred) {
    return { disposition: "deferred", eligible: false, reason: `authority defers autonomous work (${deferred})` };
  }
  const isFinding = config.assessment.findingLabels.some((label) => stateMatches(states, label));
  const approvedFinding = isFinding && config.assessment.approvedStates.some((state) => stateMatches(states, state));
  if (!approvedFinding && !config.selection.readyStates.some((wanted) => stateMatches(states, wanted))) {
    return { disposition: "not_ready", eligible: false, reason: `authority is not ready (missing configured ready state: ${config.selection.readyStates.join(", ")})` };
  }
  return { disposition: "eligible", eligible: true, reason: "authority is eligible and ready" };
}

function archivedIssueNumbers(cwd: string): Set<number> {
  const archivedDir = join(psDir(cwd), "ARCHIVED");
  if (!existsSync(archivedDir)) return new Set();

  const files = readdirSync(archivedDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => {
      const path = join(archivedDir, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, ARCHIVED_SCAN_LIMIT);

  const issues = new Set<number>();
  for (const { path } of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/\*\*GitHub-Issue:\*\*\s*#(\d+)/gi)) {
      const issue = Number.parseInt(match[1], 10);
      if (Number.isInteger(issue) && issue > 0) issues.add(issue);
    }
  }
  return issues;
}

function deferredIssueVersions(cwd: string): Map<number, string | undefined> {
  const deferredDir = join(psDir(cwd), "deferred");
  if (!existsSync(deferredDir)) return new Map();

  const files = readdirSync(deferredDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => {
      const path = join(deferredDir, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, DEFERRED_SCAN_LIMIT);

  const versions = new Map<number, string | undefined>();
  for (const { path } of files) {
    const text = readFileSync(path, "utf8");
    const issueMatch = text.match(/\*\*GitHub-Issue:\*\*\s*#(\d+)/i);
    if (!issueMatch) continue;
    const issue = Number.parseInt(issueMatch[1], 10);
    if (!Number.isInteger(issue) || issue <= 0 || versions.has(issue)) continue;
    const updatedAt = text.match(/\*\*Issue-Updated-At:\*\*\s*([^\n]+)/i)?.[1]?.trim();
    versions.set(issue, updatedAt && updatedAt !== "unverified" ? updatedAt : undefined);
  }
  return versions;
}

export function deferredIssueStillUnchanged(
  issue: CandidateIssue,
  localDeferred: Map<number, string | undefined>,
): boolean {
  if (!localDeferred.has(issue.number)) return false;
  const deferredUpdatedAt = localDeferred.get(issue.number);
  // Missing/invalid freshness provenance is unsafe to suppress: let the issue
  // re-enter selection so the normal live-authority reconciliation can repair it.
  if (!deferredUpdatedAt || !issue.updatedAt) return false;
  const deferredTime = Date.parse(deferredUpdatedAt);
  const liveTime = Date.parse(issue.updatedAt);
  if (!Number.isFinite(deferredTime) || !Number.isFinite(liveTime)) return false;
  return liveTime <= deferredTime;
}

export async function candidateShortlist(
  cwd: string,
  options: CandidateShortlistOptions = {},
): Promise<CandidateShortlist> {
  const selectionStartedAt = Date.now();
  const selectionDeadlineMs = options.selectionDeadlineMs ?? DEFAULT_CANDIDATE_SELECTION_DEADLINE_MS;
  const operationTimeoutMs = options.authorityTimeoutMs ?? authorityOperationTimeoutMs();
  let lastProgressAt = selectionStartedAt;
  const report = (message: string): void => {
    lastProgressAt = Date.now();
    options.onStatus?.(message);
  };
  const bounded = async <T>(operation: string, work: () => Promise<T>): Promise<T> => {
    const remaining = selectionDeadlineMs - (Date.now() - selectionStartedAt);
    if (remaining <= 0) throw new Error(`Candidate selection deadline exceeded; last progress ${Date.now() - lastProgressAt}ms ago`);
    return withAuthorityTimeout(operation, work(), Math.min(operationTimeoutMs, remaining));
  };
  const unavailable = (error: unknown): CandidateShortlist => {
    const elapsed = Date.now() - selectionStartedAt;
    const sinceProgress = Date.now() - lastProgressAt;
    const reason = `${error instanceof Error ? error.message : String(error)} (candidate selection elapsed ${elapsed}ms; last progress ${sinceProgress}ms ago)`;
    report(`Candidate discovery unavailable after ${elapsed}ms`);
    return { exhausted: false, outcome: "unavailable", reason };
  };

  const config = options.config ?? loadPiNextConfig(cwd);
  const authority = options.authority ?? createWorkAuthority(cwd, config);
  requireAuthorityCapability(authority, "discovery");

  // No PLAN means this is an issue boundary. Refresh the production checkout
  // before reading the shared backlog so every new worker starts from other
  // agents' already-published work. A dirty coordination checkout is allowed:
  // another agent may be using it, and the selected issue gets its own
  // worktree before the model session starts.
  report(`Checking ${authority.name} for actionable work (${config.selection.priorities.join(", ")})`);
  if (options.refreshMain !== false) {
    try {
      await bounded("refresh main", () => refreshMainAtIssueBoundary(cwd, report));
    } catch (error) {
      return unavailable(error);
    }
  } else {
    report("Skipping shared main refresh; another agent owns the coordination checkout");
  }
  report(`${authority.name} work-item selection is in progress`);

  const localArchived =
    options.includeLocalArchiveExclusions === false
      ? new Set<number>()
      : archivedIssueNumbers(cwd);
  const localDeferred = deferredIssueVersions(cwd);
  // Deferred freshness is authoritative: do not permanently exclude a parked
  // issue from the set before checking whether GitHub has advanced it.
  // Current-run containment is a hard exclusion. It is intentionally separate
  // from local deferred freshness: an issue blocked in this bounded run must
  // not be selected again until the run ends, even if authority still lists it.
  const currentRunDeferred = new Set(options.deferredIssues || []);
  const schedulerExcluded = new Set(options.schedulerExcludedIssues || []);
  const excluded = new Set([
    ...(options.completedIssues || []),
    ...currentRunDeferred,
    ...schedulerExcluded,
    ...localArchived,
  ]);
  const groups: string[] = [];
  let firstCandidateIssueNumber: number | undefined;
  const excludedOpen: number[] = [];
  const pendingVerificationOpen: number[] = [];
  const deferredOpen: number[] = [];
  const currentRunDeferredOpen: number[] = [];
  const leasedElsewhere = new Set<number>();
  try {
    report(`Querying ${authority.name} work items`);
    const queriedItems = await bounded(`${authority.name} candidate discovery`, () => authority.listCandidates(config));
    const itemByNumber = new Map<number, AuthorityWorkItem>();
    const queried = queriedItems
      .filter((item) => {
        const eligibility = classifyAuthorityEligibility(item, config);
        if (eligibility.disposition !== "deferred") return true;
        if (isAwaitingExternalVerification(item) && Number.isSafeInteger(item.number) && item.number! > 0) {
          pendingVerificationOpen.push(item.number!);
        }
        return false;
      })
      .map((item) => {
        const issue = candidateFromAuthority(item);
        if (issue) itemByNumber.set(issue.number, item);
        return issue;
      })
      .filter((issue): issue is CandidateIssue => Boolean(issue));
    for (const issue of queried) {
      if (localArchived.has(issue.number)) excludedOpen.push(issue.number);
      if (currentRunDeferred.has(issue.number)) currentRunDeferredOpen.push(issue.number);
      if (deferredIssueStillUnchanged(issue, localDeferred)) deferredOpen.push(issue.number);
    }

    const eligible = queried
      .filter((issue) => {
        const item = itemByNumber.get(issue.number);
        return Boolean(item) &&
          !excluded.has(issue.number) &&
          !deferredIssueStillUnchanged(issue, localDeferred) &&
          classifyAuthorityEligibility(item!, config).eligible;
      })
      .sort((left, right) => {
        const leftPriority = config.selection.priorities.indexOf(labelNames(left).find((label) => label.startsWith("priority:"))?.slice("priority:".length).trim() || "");
        const rightPriority = config.selection.priorities.indexOf(labelNames(right).find((label) => label.startsWith("priority:"))?.slice("priority:".length).trim() || "");
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        const leftReady = config.selection.readyStates.some((state) => stateMatches(labelNames(left), state)) ? 1 : 0;
        const rightReady = config.selection.readyStates.some((state) => stateMatches(labelNames(right), state)) ? 1 : 0;
        if (leftReady !== rightReady) return rightReady - leftReady;
        return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
      });

    // Inspect only a small progressive window. A foreign lease is a candidate
    // local skip, but a failed read is an authority failure: absence cannot be
    // inferred from a timeout and no issue may be mutated before the CAS claim.
    const readWindow = Math.max(1, Math.trunc(options.leaseReadWindow ?? DEFAULT_LEASE_READ_WINDOW));
    const concurrency = Math.max(1, Math.trunc(options.leaseReadConcurrency ?? DEFAULT_LEASE_READ_CONCURRENCY));
    if (options.leaseAuthority) {
      for (let offset = 0; offset < eligible.length && firstCandidateIssueNumber === undefined; offset += readWindow) {
        const window = eligible.slice(offset, offset + readWindow);
        report(`Checking leases 0/${window.length}`);
        for (let start = 0; start < window.length; start += concurrency) {
          const batch = window.slice(start, start + concurrency);
          const results = await Promise.all(batch.map(async (issue) => {
            const lease = await bounded(`lease read #${issue.number}`, () => options.leaseAuthority!.read(issue.number));
            report(`Checking leases ${Math.min(window.length, start + batch.indexOf(issue) + 1)}/${window.length}`);
            return [issue.number, lease] as const;
          }));
          for (const [issueNumber, lease] of results) {
            if (lease && isIssueLeaseFresh(lease, options.now || new Date())) leasedElsewhere.add(issueNumber);
          }
        }
        const available = window.find((issue) => !leasedElsewhere.has(issue.number));
        if (available) firstCandidateIssueNumber = available.number;
      }
    } else {
      firstCandidateIssueNumber = eligible[0]?.number;
    }

    for (let priority = 0; priority < config.selection.priorities.length; priority += 1) {
      const priorityName = config.selection.priorities[priority];
      const wanted = PRIORITY_BUCKET_LIMITS[Math.min(priority, PRIORITY_BUCKET_LIMITS.length - 1)] ?? 2;
      const issues = eligible
        .filter((issue) => {
          const item = itemByNumber.get(issue.number);
          return item?.priority === priorityName && !leasedElsewhere.has(issue.number);
        })
        .slice(0, wanted);
      if (!issues.length) continue;
      groups.push(
        `${priorityName}:\n${issues.map((issue) => {
          const labels = labelNames(issue).filter((label) => /^(status:|type:)/.test(label)).join(", ");
          return `- #${issue.number} ${issue.title}${labels ? ` [${labels}]` : ""}`;
        }).join("\n")}`,
      );
    }
  } catch (error) {
    // Never trust a partial authority view: a failed query could otherwise hide urgent work.
    return unavailable(error);
  }

  const notes: string[] = [];
  const archivedNotes = [...new Set(excludedOpen)].sort((left, right) => left - right);
  if (archivedNotes.length) {
    notes.push(
      `Locally archived open issues omitted from this shortlist: ${archivedNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. Do not reselect them unless live GitHub comments or labels show new actionable requirements after archive.`,
    );
  }
  const currentRunNotes = [...new Set(currentRunDeferredOpen)].sort((left, right) => left - right);
  if (currentRunNotes.length) {
    notes.push(
      `Issues contained earlier in this run omitted from the shortlist: ${currentRunNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. They are not eligible for reselection during this run.`,
    );
  }
  const pendingNotes = [...new Set(pendingVerificationOpen)].sort((left, right) => left - right);
  if (pendingNotes.length) {
    notes.push(
      `Issues awaiting authoritative external verification omitted from autonomous implementation selection: ${pendingNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. They become eligible again only after a structured PASS/FAIL result or a configured verification worker path.`,
    );
  }
  const deferredNotes = [...new Set(deferredOpen)].sort((left, right) => left - right);
  if (deferredNotes.length) {
    notes.push(
      `Locally deferred issues omitted while their live GitHub updatedAt has not advanced: ${deferredNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. They become eligible again automatically after a new authoritative GitHub update.`,
    );
  }
  const schedulerNotes = [...schedulerExcluded].sort((left, right) => left - right);
  if (schedulerNotes.length) {
    notes.push(
      `Candidates skipped by this scheduler run due to fresh ownership omitted from reselection: ${schedulerNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. They remain outstanding requested capacity and are not product failures.`,
    );
  }
  const leasedElsewhereIssues = [...leasedElsewhere].sort((left, right) => left - right);
  if (leasedElsewhereIssues.length) {
    notes.push(
      `Eligible issues currently leased by another fresh owner omitted from this shortlist: ${leasedElsewhereIssues
        .map((issue) => `#${issue}`)
        .join(", ")}. They remain outstanding requested capacity and are not product failures.`,
    );
  }
  const note = notes.join("\n");

  if (!groups.length) {
    return { text: note || undefined, exhausted: true, outcome: "exhausted", leasedElsewhereIssues };
  }
  return {
    text: [groups.join("\n\n"), note].filter(Boolean).join("\n\n"),
    exhausted: false,
    outcome: "candidate",
    candidateIssueNumber: firstCandidateIssueNumber,
    leasedElsewhereIssues,
  };
}

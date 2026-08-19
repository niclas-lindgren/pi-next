import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { psDir } from "./util.ts";
import type { IssueLeaseAuthority } from "./issue-leases.ts";
import { isIssueLeaseFresh } from "./issue-authority.ts";
import { refreshMainAtIssueBoundary } from "./main-refresh.ts";

const execFileAsync = promisify(execFile);
const PRIORITY_BUCKET_LIMITS = [3, 5, 3, 2] as const;
const PRIORITY_QUERY_LIMIT = 100;
const ARCHIVED_SCAN_LIMIT = 200;
const DEFERRED_SCAN_LIMIT = 100;

interface CandidateIssue {
  number: number;
  title: string;
  updatedAt?: string;
  labels?: Array<{ name?: string }>;
}

export interface CandidateShortlist {
  text?: string;
  exhausted: boolean;
}

export interface CandidateShortlistOptions {
  completedIssues?: number[];
  deferredIssues?: number[];
  includeLocalArchiveExclusions?: boolean;
  /** Shared authority used to refresh ownership immediately before selection. */
  leaseAuthority?: IssueLeaseAuthority;
  now?: Date;
  /** Reports slow GitHub/refresh phases to the interactive command UI. */
  onStatus?: (message: string) => void;
  /** Skip refreshing the shared coordination checkout when another agent owns its dirty state. */
  refreshMain?: boolean;
}

function labelNames(issue: CandidateIssue): string[] {
  return (issue.labels || [])
    .map((label) => label.name || "")
    .filter(Boolean);
}

/** Blocked issues require an explicit recovery/decision and are never an
 * autonomous candidate, even when they carry a higher priority label. */
export function isBlockedCandidate(issue: Pick<CandidateIssue, "labels">): boolean {
  return (issue.labels || []).some((label) => label.name === "status:blocked");
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
  // No PLAN means this is an issue boundary. Refresh the production checkout
  // before reading the shared backlog so every new worker starts from other
  // agents' already-published work. A dirty coordination checkout is allowed:
  // another agent may be using it, and the selected issue gets its own
  // worktree before the model session starts.
  options.onStatus?.("Checking GitHub for actionable issues (P0–P3)");
  if (options.refreshMain !== false) {
    await refreshMainAtIssueBoundary(cwd, options.onStatus);
  } else {
    options.onStatus?.("Skipping shared main refresh; another agent owns the coordination checkout");
  }
  options.onStatus?.("GitHub issue selection is in progress");

  const localArchived =
    options.includeLocalArchiveExclusions === false
      ? new Set<number>()
      : archivedIssueNumbers(cwd);
  const localDeferred = deferredIssueVersions(cwd);
  // Deferred freshness is authoritative: do not permanently exclude a parked
  // issue from the set before checking whether GitHub has advanced it.
  const excluded = new Set([
    ...(options.completedIssues || []),
    ...localArchived,
  ]);
  const groups: string[] = [];
  const excludedOpen: number[] = [];
  const deferredOpen: number[] = [];
  let successfulQueries = 0;

  for (let priority = 0; priority <= 3; priority += 1) {
    const wanted = PRIORITY_BUCKET_LIMITS[priority];
    try {
      options.onStatus?.(`Querying GitHub issues for priority P${priority}`);
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          `priority: P${priority}`,
          "--limit",
          String(PRIORITY_QUERY_LIMIT),
          "--json",
          "number,title,labels,updatedAt",
        ],
        { cwd, maxBuffer: 1024 * 1024 },
      );
      successfulQueries += 1;
      const queried = JSON.parse(stdout) as CandidateIssue[];
      for (const issue of queried) {
        if (localArchived.has(issue.number)) excludedOpen.push(issue.number);
        if (deferredIssueStillUnchanged(issue, localDeferred)) {
          deferredOpen.push(issue.number);
        }
      }
      options.onStatus?.(`Checking ownership leases for priority P${priority}`);
      const liveLeases = options.leaseAuthority
        ? await Promise.all(queried.map(async (issue) => [issue.number, await options.leaseAuthority!.read(issue.number)] as const))
        : [];
      const leasedElsewhere = new Set(
        liveLeases
          .filter(([, lease]) => lease && isIssueLeaseFresh(lease, options.now || new Date()))
          .map(([issue]) => issue),
      );
      const issues = queried
        .filter(
          (issue) =>
            !excluded.has(issue.number) &&
            !deferredIssueStillUnchanged(issue, localDeferred) &&
            !isBlockedCandidate(issue) &&
            !leasedElsewhere.has(issue.number),
        )
        .sort((left, right) => {
          const leftReady = labelNames(left).includes("status:ready") ? 1 : 0;
          const rightReady = labelNames(right).includes("status:ready") ? 1 : 0;
          if (leftReady !== rightReady) return rightReady - leftReady;
          return String(right.updatedAt || "").localeCompare(
            String(left.updatedAt || ""),
          );
        })
        .slice(0, wanted);
      if (!issues.length) continue;
      groups.push(
        `P${priority}:\n${issues
          .map((issue) => {
            const labels = labelNames(issue)
              .filter((label) => /^(status:|type:)/.test(label))
              .join(", ");
            return `- #${issue.number} ${issue.title}${labels ? ` [${labels}]` : ""}`;
          })
          .join("\n")}`,
      );
    } catch {
      // Never trust a partial priority view: a failed P0 query could otherwise hide urgent work.
    }
  }

  if (successfulQueries !== PRIORITY_BUCKET_LIMITS.length) {
    return { exhausted: false };
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
  const deferredNotes = [...new Set(deferredOpen)].sort((left, right) => left - right);
  if (deferredNotes.length) {
    notes.push(
      `Locally deferred issues omitted while their live GitHub updatedAt has not advanced: ${deferredNotes
        .map((issue) => `#${issue}`)
        .join(", ")}. They become eligible again automatically after a new authoritative GitHub update.`,
    );
  }
  const note = notes.join("\n");

  if (!groups.length) {
    return { text: note || undefined, exhausted: true };
  }
  return {
    text: [groups.join("\n\n"), note].filter(Boolean).join("\n\n"),
    exhausted: false,
  };
}

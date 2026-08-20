import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPiNextConfig } from "../../src/coordination/config.ts";
import {
  createWorkAuthority,
  extractAuthorityCommentRequirements,
  requireAuthorityCapability,
  type WorkAuthorityAdapter,
} from "../../src/coordination/work-authority.ts";
import { runtimeDir, writeJsonAtomic } from "./util-core";
const MAX_RECORDS = 100;

interface FreshnessRecord {
  issueNumber: number;
  fingerprint: string;
  githubUpdatedAt?: string;
  checkedAt: string;
}

interface FreshnessState {
  version: 1;
  records: FreshnessRecord[];
}

export interface IssueFreshnessResult {
  checked: boolean;
  needsReconcile: boolean;
  reason: string;
  fingerprint?: string;
  githubUpdatedAt?: string;
}

export interface LiveIssueFingerprint {
  title: string;
  fingerprint: string;
  githubUpdatedAt?: string;
  acceptanceCriteria: string[];
  risk: "low" | "normal" | "high" | "critical";
}

function freshnessFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-issue-freshness.json");
}

function readState(cwd: string): FreshnessState {
  const path = freshnessFile(cwd);
  if (!existsSync(path)) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FreshnessState;
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { version: 1, records: [] };
  }
}

function persistRecord(cwd: string, record: FreshnessRecord): void {
  const state = readState(cwd);
  const records = state.records.filter((item) => item.issueNumber !== record.issueNumber);
  records.push(record);
  writeJsonAtomic(freshnessFile(cwd), {
    version: 1,
    records: records.slice(-MAX_RECORDS),
  });
}

function checkboxLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

/**
 * Extract the issue body's authoritative acceptance checklist without asking
 * the model to restate it. Prefer an explicit Acceptance Criteria section;
 * fall back to all issue-body checkboxes only when no such heading exists.
 */
export function extractIssueAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /^#{2,6}\s+acceptance\s+criteria\s*$/i.test(line.trim()),
  );
  if (headingIndex < 0) return checkboxLines(body);

  const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1]?.length ?? 2;
  const sectionLines: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#+)\s+/);
    if (heading && heading[1].length <= headingLevel) break;
    sectionLines.push(lines[index]);
  }
  return checkboxLines(sectionLines.join("\n"));
}

/**
 * Return a deterministic fingerprint of the live issue authority surface and
 * the acceptance checklist parsed directly from the issue body. The hash
 * covers issue state/title/body/labels and comments, so a new product decision
 * or clarification invalidates prior semantic verification.
 */
export async function getLiveIssueFingerprint(
  cwd: string,
  issueNumber: number,
  authority?: WorkAuthorityAdapter,
): Promise<LiveIssueFingerprint> {
  const config = loadPiNextConfig(cwd);
  const adapter = authority ?? createWorkAuthority(cwd, config);
  requireAuthorityCapability(adapter, "freshness");
  const item = await adapter.get(String(issueNumber));
  const authorityText = `${item.title} ${item.body} ${item.priority || ""} ${item.states.join(" ")}`.toLowerCase();
  const risk = /(?:risk\s*:\s*critical|security|credential|payment|funds|authorization|privacy|schema|migration)/.test(authorityText)
    ? "critical"
    : /(?:risk\s*:\s*high|priority\s*:?\s*p0|p0)/.test(authorityText)
      ? "high"
      : "normal";
  const bodyCriteria = extractIssueAcceptanceCriteria(item.body);
  const commentCriteria = adapter.projectRequirements
    ? adapter.projectRequirements(item)
    : extractAuthorityCommentRequirements(item.comments);
  const criteria = [...bodyCriteria, ...commentCriteria];
  return {
    title: item.title,
    fingerprint: adapter.fingerprint(item),
    githubUpdatedAt: item.updatedAt,
    acceptanceCriteria: [...new Set(criteria.map((criterion) => criterion.trim()).filter(Boolean))],
    risk,
  };
}

export async function checkIssueFreshness(
  cwd: string,
  issueNumber: number,
): Promise<IssueFreshnessResult> {
  const previous = readState(cwd).records.find(
    (item) => item.issueNumber === issueNumber,
  );
  try {
    const live = await getLiveIssueFingerprint(cwd, issueNumber);
    persistRecord(cwd, {
      issueNumber,
      fingerprint: live.fingerprint,
      githubUpdatedAt: live.githubUpdatedAt,
      checkedAt: new Date().toISOString(),
    });
    if (!previous) {
      return {
        checked: true,
        needsReconcile: true,
        reason:
          "No trusted live-issue baseline exists for this active plan; reconcile the plan before implementation.",
        fingerprint: live.fingerprint,
        githubUpdatedAt: live.githubUpdatedAt,
      };
    }
    if (previous.fingerprint !== live.fingerprint) {
      return {
        checked: true,
        needsReconcile: true,
        reason:
          "The live GitHub issue or its comments/labels changed since the previous transition; reconcile PLAN.md before implementation.",
        fingerprint: live.fingerprint,
        githubUpdatedAt: live.githubUpdatedAt,
      };
    }
    return {
      checked: true,
      needsReconcile: false,
      reason: "Live GitHub issue fingerprint matches the previous transition.",
      fingerprint: live.fingerprint,
      githubUpdatedAt: live.githubUpdatedAt,
    };
  } catch {
    return {
      checked: false,
      needsReconcile: true,
      reason:
        "Controller could not verify live GitHub issue freshness; the model must fetch the live issue and comments before using PLAN.md.",
    };
  }
}

export async function primeIssueFreshness(
  cwd: string,
  issueNumber: number,
): Promise<void> {
  try {
    const live = await getLiveIssueFingerprint(cwd, issueNumber);
    persistRecord(cwd, {
      issueNumber,
      fingerprint: live.fingerprint,
      githubUpdatedAt: live.githubUpdatedAt,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort only. The next active-plan transition will force live reconciliation if no baseline exists.
  }
}

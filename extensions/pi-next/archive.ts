import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, sep } from "node:path";

import { workflowPath } from "./util-core.ts";

export interface ArchivePlanArtifactsInput {
  issue: number;
  plan: string;
  now?: Date;
}

export interface ArchivePlanArtifactsResult {
  archive: string;
  history: string;
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join("/");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function planTitle(plan: string, issue: number): string {
  return plan.match(/^#\s+(.+)$/m)?.[1]?.trim() || `issue-${issue}`;
}

/**
 * Archive the verified canonical PLAN using only package-owned runtime code.
 *
 * Archive/history locations remain consumer-configurable through the normal
 * workflow config, but a consumer no longer needs an executable helper under
 * `.pi-next/scripts`. The archive path is deterministic for one issue/day so
 * retries cannot silently create a stream of duplicate archive files.
 */
export function archivePlanArtifacts(
  cwd: string,
  input: ArchivePlanArtifactsInput,
): ArchivePlanArtifactsResult {
  const planPath = workflowPath(cwd, "planPath");
  if (!existsSync(planPath)) {
    throw new Error(`PLAN.md not found at ${planPath}`);
  }

  const archiveDir = workflowPath(cwd, "archiveDir");
  const stateDir = workflowPath(cwd, "stateDir");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const title = planTitle(input.plan, input.issue);
  const titleSlug = slug(title) || `issue-${input.issue}`;
  const archive = `${archiveDir}/PLAN-${date}-${input.issue}-${titleSlug}.md`;
  const history = `${stateDir}/HISTORY.md`;
  const archiveRelative = repoRelative(cwd, archive);

  if (existsSync(archive)) {
    const existing = readFileSync(archive, "utf8");
    if (existing !== input.plan) {
      throw new Error(
        `Archive destination already exists with different content: ${archive}`,
      );
    }
  } else {
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(archive, input.plan, "utf8");
  }

  const historyLine = `- ${date}: archived verified plan for issue #${input.issue} (${title}) [${archiveRelative}]`;
  const currentHistory = existsSync(history) ? readFileSync(history, "utf8") : "";
  if (!currentHistory.split(/\r?\n/).includes(historyLine)) {
    const prefix = currentHistory
      ? currentHistory.endsWith("\n") ? "" : "\n"
      : "# Build History\n";
    appendFileSync(history, `${prefix}${historyLine}\n`, "utf8");
  }

  unlinkSync(planPath);
  return { archive, history };
}

/** Package-owned archive implementation intentionally ignores helperDir. */
export const packageOwnedArchiveMarker = basename(import.meta.url);

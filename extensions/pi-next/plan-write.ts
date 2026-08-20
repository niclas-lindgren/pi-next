import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { workflowArtifacts, type WorkflowArtifact } from "./plan-read";
import { runtimeDir, workflowPath } from "./util-core.ts";

export function markDone(plan: string, prefix: string, log: string): string {
  const tasksStart = plan.indexOf("## Tasks");
  if (tasksStart < 0) throw new Error("PLAN.md is missing ## Tasks");
  const tasksEnd = plan.indexOf("\n## ", tasksStart + "## Tasks".length);
  const end = tasksEnd < 0 ? plan.length : tasksEnd;
  const before = plan.slice(0, tasksStart);
  const tasks = plan.slice(tasksStart, end);
  const after = plan.slice(end);
  const lines = tasks.split(/\r?\n/);
  const index = lines.findIndex(
    (line) => line.startsWith("- [ ] ") && line.slice(6).startsWith(prefix),
  );
  if (index < 0) {
    throw new Error(`Unchecked task starting with '${prefix}' not found`);
  }
  lines[index] = lines[index].replace("- [ ] ", "- [x] ");
  const updated = `${before}${lines.join("\n")}${after}`;
  if (!updated.includes("## Log")) throw new Error("PLAN.md is missing ## Log");
  return updated.replace(/(## Log\s*)/, `$1\n${log.trim()}\n`);
}

export function appendFix(
  plan: string,
  task: string,
  files: string,
  approach: string,
): string {
  const block = `- [ ] [Fix] ${task}\n  - Files: ${files || "TBD"}\n  - Approach: ${approach || "Patch the smallest relevant surface and rerun verification."}\n`;
  const tasksStart = plan.indexOf("## Tasks");
  const next = plan.indexOf("\n## ", tasksStart + 1);
  if (next < 0) return `${plan.trim()}\n${block}`;
  return `${plan.slice(0, next).trim()}\n${block}${plan.slice(next)}`;
}

export function issueNumber(plan: string): number | null {
  const match = plan.match(/^\*\*GitHub-[Ii]ssue:\*\*\s*#?(\d+)/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

export interface QuarantinedWorkflowArtifact extends WorkflowArtifact {
  target: string;
}

/**
 * Remove copied issue-local artifacts from a newly attached worktree without
 * touching the coordination checkout. Only byte-identical copies of foreign
 * root artifacts are moved; a different artifact is treated as recoverable
 * workspace state and left for explicit authority reconciliation.
 */
export function quarantineInheritedWorkflowArtifacts(
  coordinationCwd: string,
  workspaceCwd: string,
  issueNumber: number,
): QuarantinedWorkflowArtifact[] {
  const coordinationArtifacts = workflowArtifacts(coordinationCwd);
  const workspaceArtifacts = workflowArtifacts(workspaceCwd);
  const quarantined: QuarantinedWorkflowArtifact[] = [];

  for (const artifact of workspaceArtifacts) {
    if (artifact.issueNumber === issueNumber) continue;
    const source = coordinationArtifacts.find(
      (candidate) =>
        candidate.kind === artifact.kind &&
        candidate.issueNumber === artifact.issueNumber &&
        existsSync(candidate.path) &&
        readFileSync(candidate.path, "utf8") === readFileSync(artifact.path, "utf8"),
    );
    if (!source) continue;

    const suffix = artifact.kind === "plan" ? "PLAN.md" : "VERIFY.md";
    const identity = artifact.issueNumber === undefined ? "unknown" : String(artifact.issueNumber);
    const targetDirectory = workflowPath(workspaceCwd, "deferredDir");
    mkdirSync(targetDirectory, { recursive: true });
    const target = join(targetDirectory, `inherited-issue-${identity}-${suffix}`);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== readFileSync(artifact.path, "utf8")) {
        throw new Error(
          `Cannot quarantine ${artifact.path}: deterministic target already contains different content at ${target}`,
        );
      }
      // A prior interrupted handoff already preserved the exact artifact.
      // Remove only the duplicate source; never overwrite divergent content.
      unlinkSync(artifact.path);
    } else {
      renameSync(artifact.path, target);
    }
    quarantined.push({ ...artifact, target });
  }

  return quarantined;
}

export function quarantineLegacyCoordinationArtifacts(
  cwd: string,
): QuarantinedWorkflowArtifact[] {
  const artifacts = workflowArtifacts(cwd);
  const quarantined: QuarantinedWorkflowArtifact[] = [];
  for (const artifact of artifacts) {
    const suffix = artifact.kind === "plan" ? "PLAN.md" : "VERIFY.md";
    const identity = artifact.issueNumber === undefined ? "unknown" : String(artifact.issueNumber);
    const targetDirectory = join(runtimeDir(cwd), "legacy-workflow");
    mkdirSync(targetDirectory, { recursive: true });
    const target = join(targetDirectory, `legacy-root-${identity}-${suffix}`);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== readFileSync(artifact.path, "utf8")) {
        throw new Error(
          `Cannot quarantine legacy coordination artifact ${artifact.path}: target contains different content at ${target}`,
        );
      }
      unlinkSync(artifact.path);
    } else {
      renameSync(artifact.path, target);
    }
    quarantined.push({ ...artifact, target });
  }
  return quarantined;
}

export function relativeWorkflowPaths(
  cwd: string,
  artifacts: readonly QuarantinedWorkflowArtifact[],
): string[] {
  return artifacts.flatMap(({ path, target }) => [
    relative(cwd, path),
    relative(cwd, target),
  ]);
}

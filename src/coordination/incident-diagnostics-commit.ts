import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CANONICAL_STATUS_ARGS, changedFilePathsFromStatus } from "../bootstrap/git-status.ts";
import { loadPiNextConfig } from "./config.ts";
import { assertWorkflowCommitAllowed, recordCommit } from "./workflow-commit-policy.ts";

interface MinimalCommandResult { exitCode: number; stdout: string; stderr: string; }
export type IncidentDiagnosticsCommitCommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<MinimalCommandResult>;

export interface IncidentDiagnosticsCommitResult {
  status: "clean" | "committed" | "not-incident-only" | "budget-exhausted";
  paths: readonly string[];
  commitSha?: string;
  reason?: string;
}

async function git(root: string, args: string[], runner: IncidentDiagnosticsCommitCommandRunner): Promise<string> {
  const result = await runner("git", ["-C", root, ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function gitRaw(root: string, args: string[], runner: IncidentDiagnosticsCommitCommandRunner): Promise<string> {
  const result = await runner("git", ["-C", root, ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function incidentDiagnosticsPrefix(root: string): string {
  const diagnostics = loadPiNextConfig(root).workflow.diagnosticsPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return `${diagnostics}/incidents/`;
}

function incidentIssueNumbers(root: string, paths: readonly string[], fallbackIssueNumber?: number): number[] {
  const issues = new Set<number>();
  if (fallbackIssueNumber) issues.add(fallbackIssueNumber);
  for (const path of paths) {
    if (!path.endsWith(".json")) continue;
    const fullPath = join(root, path);
    if (!existsSync(fullPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as {
        source?: { issueNumber?: unknown };
        lifecycle?: { issueNumber?: unknown };
      };
      const issue = parsed.source?.issueNumber ?? parsed.lifecycle?.issueNumber;
      if (typeof issue === "number" && Number.isInteger(issue) && issue > 0) issues.add(issue);
    } catch {
      // Optional diagnostics may be corrupt; leave them unbudgeted rather than
      // disguising them as another issue's telemetry.
    }
  }
  return [...issues].sort((a, b) => a - b);
}

/**
 * Commit and push only sanitized incident diagnostics that would otherwise
 * dirty the coordination checkout. Any non-incident path, non-main checkout,
 * or non-exact local main remains fail-closed for the caller to preserve.
 */
export async function commitIncidentDiagnostics(input: {
  root: string;
  runCommand: IncidentDiagnosticsCommitCommandRunner;
  reporter?: (line: string) => void;
  issueNumber?: number;
}): Promise<IncidentDiagnosticsCommitResult> {
  const raw = await gitRaw(input.root, [...CANONICAL_STATUS_ARGS], input.runCommand);
  const paths = changedFilePathsFromStatus(raw);
  if (paths.length === 0) return { status: "clean", paths: [] };

  const prefix = incidentDiagnosticsPrefix(input.root);
  if (paths.some((path) => !path.startsWith(prefix))) {
    return { status: "not-incident-only", paths, reason: "coordination checkout has non-incident changes" };
  }

  const branch = await git(input.root, ["branch", "--show-current"], input.runCommand);
  if (branch !== "main") return { status: "not-incident-only", paths, reason: `coordination checkout is on ${branch || "detached HEAD"}` };
  await git(input.root, ["fetch", "origin", "main", "--quiet"], input.runCommand);
  const localMain = await git(input.root, ["rev-parse", "HEAD"], input.runCommand);
  const originMain = await git(input.root, ["rev-parse", "refs/remotes/origin/main"], input.runCommand);
  if (localMain !== originMain) return { status: "not-incident-only", paths, reason: "local main is not exactly origin/main" };

  const issues = incidentIssueNumbers(input.root, paths, input.issueNumber);
  for (const issue of issues) {
    try {
      assertWorkflowCommitAllowed(input.root, issue);
    } catch (error) {
      return {
        status: "budget-exhausted",
        paths,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  await git(input.root, ["add", "--", ...paths], input.runCommand);
  const staged = await git(input.root, ["diff", "--cached", "--name-only"], input.runCommand);
  if (!staged.trim()) return { status: "clean", paths: [] };
  await git(input.root, ["commit", "-m", "chore(agent): record finalization incident diagnostics"], input.runCommand);
  const commitSha = await git(input.root, ["rev-parse", "HEAD"], input.runCommand);
  await git(input.root, ["push", "origin", "HEAD:main"], input.runCommand);
  for (const issue of issues) recordCommit(input.root, issue, "lifecycle");
  input.reporter?.(`incident diagnostics · committed ${commitSha.slice(0, 12)}`);
  return { status: "committed", paths, commitSha };
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CurrentTask {
  task: string;
  prefix: string;
  files: string[];
  approach: string;
  block: string;
}

export interface WorkflowArtifact {
  kind: "plan" | "verify";
  path: string;
  issueNumber?: number;
}

/**
 * Return the issue identity embedded in a workflow artifact, when present.
 * VERIFY.md uses the structured GITHUB_ISSUE field while PLAN.md uses the
 * canonical GitHub-Issue field. Keeping this parser here lets lifecycle code
 * distinguish an inherited artifact from the issue's own recoverable state.
 */
export function workflowArtifactIssue(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const match =
    text.match(/^\*\*GitHub-[Ii]ssue:\*\*\s*#?(\d+)/m) ||
    text.match(/^GITHUB_ISSUE:\s*#?(\d+)/m);
  const issueNumber = Number.parseInt(match?.[1] || "", 10);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined;
}

export function workflowArtifacts(cwd: string): WorkflowArtifact[] {
  const directory = join(cwd, ".ps-next");
  if (!existsSync(directory)) return [];
  const planPaths = readdirSync(directory)
    .filter((name) => name === "PLAN.md" || /^PLAN-[^/]+\.md$/.test(name))
    .map((name) => join(directory, name));
  const paths = [
    ...planPaths.map((path) => ({ kind: "plan" as const, path })),
    { kind: "verify" as const, path: join(directory, "VERIFY.md") },
  ];
  return paths
    .filter(({ path }) => existsSync(path))
    .map((artifact) => ({
      ...artifact,
      issueNumber: workflowArtifactIssue(artifact.path),
    }));
}

export interface AcceptanceCriterion {
  checked: boolean;
  text: string;
}

function headingIndex(lines: readonly string[], heading: string): number {
  const target = heading.trim().toLowerCase();
  return lines.findIndex((line) => line.trim().toLowerCase() === target);
}

export function section(plan: string, heading: string): string {
  const lines = plan.split(/\r?\n/);
  const start = headingIndex(lines, heading);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

export function currentTask(plan: string): CurrentTask | null {
  const lines = section(plan, "## Tasks").split(/\r?\n/);
  const start = lines.findIndex((line) => /^- \[ \] /.test(line));
  if (start < 0) return null;

  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- \[[ x]\] /.test(lines[index])) break;
    block.push(lines[index]);
  }

  const task = lines[start].replace(/^- \[ \] /, "").trim();
  const filesLine = block.find((line) => /^\s*- Files:/.test(line));
  const approachLine = block.find((line) => /^\s*- Approach:/.test(line));
  return {
    task,
    prefix: task.slice(0, 80),
    files: filesLine
      ? filesLine
          .replace(/^\s*- Files:\s*/, "")
          .split(",")
          .map((file) => file.trim())
          .filter(Boolean)
      : [],
    approach: approachLine?.replace(/^\s*- Approach:\s*/, "").trim() || "",
    block: block.join("\n"),
  };
}

export function acceptanceCriteria(plan: string): AcceptanceCriterion[] {
  return section(plan, "## Acceptance Criteria")
    .split(/\r?\n/)
    .map((line) => line.match(/^- \[([ x])\] (.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ checked: match[1] === "x", text: match[2].trim() }));
}

export function validatePlan(plan: string): string[] {
  const errors: string[] = [];
  for (const token of ["# Plan:", "**Goal:**"]) {
    if (!plan.includes(token)) errors.push(`Missing ${token}`);
  }
  const lines = plan.split(/\r?\n/);
  for (const heading of ["## Tasks", "## Acceptance Criteria", "## Log"]) {
    if (headingIndex(lines, heading) < 0) errors.push(`Missing ${heading}`);
  }
  if (!/^\*\*GitHub-[Ii]ssue:\*\*\s*#?\d+/m.test(plan)) {
    errors.push("Missing **GitHub-Issue:** N");
  }

  const tasks = section(plan, "## Tasks");
  const matches = [...tasks.matchAll(/^- \[[ x]\] .+$/gm)];
  if (!matches.length) errors.push("No task checkbox lines found");
  for (const match of matches) {
    const rest = tasks.slice(match.index || 0);
    const next = rest.search(/\n- \[[ x]\] /);
    const block = next < 0 ? rest : rest.slice(0, next);
    const name = match[0].replace(/^- \[[ x]\] /, "");
    if (!/^\s*- Files:/m.test(block)) errors.push(`Task missing Files: ${name}`);
    if (!/^\s*- Approach:/m.test(block)) errors.push(`Task missing Approach: ${name}`);
  }

  if (!acceptanceCriteria(plan).length) errors.push("No acceptance criteria found");
  return errors;
}

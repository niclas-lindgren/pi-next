import { BootstrapError } from "./errors.js";
import { runCommand } from "./command-runner.js";
import { CommandRunner, Issue, RoadmapIssue } from "./types.js";
import { assertCommand } from "./git-utils.js";

export function issueFromJson(value: unknown): Issue {
  if (!value || typeof value !== "object") throw new BootstrapError("GitHub returned an invalid issue payload");
  const item = value as Partial<Issue>;
  if (typeof item.number !== "number" || typeof item.title !== "string" || typeof item.body !== "string") {
    throw new BootstrapError("GitHub issue payload is missing number, title, or body");
  }
  return { number: item.number, title: item.title, body: item.body, comments: Array.isArray(item.comments) ? item.comments : [] };
}

export function roadmapIssueFromJson(value: unknown): RoadmapIssue {
  const issue = issueFromJson(value);
  const item = value as { state?: unknown; labels?: unknown };
  const state = item.state === "CLOSED" ? "CLOSED" : item.state === "OPEN" ? "OPEN" : undefined;
  if (!state) throw new BootstrapError("GitHub issue payload is missing state");
  const labels = Array.isArray(item.labels)
    ? item.labels.map((label) => typeof label === "string" ? label : typeof label?.name === "string" ? label.name : "").filter(Boolean)
    : [];
  return { ...issue, state, labels };
}

export async function fetchIssue(issueNumber: number, cwd: string, runner: CommandRunner = runCommand): Promise<Issue> {
  const result = await runner("gh", ["issue", "view", String(issueNumber), "--json", "number,title,body,comments"], { cwd });
  return issueFromJson(JSON.parse(assertCommand(result, `fetch issue #${issueNumber}`)));
}

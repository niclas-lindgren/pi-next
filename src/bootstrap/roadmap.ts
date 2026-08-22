import { BootstrapError } from "./errors.js";
import { runCommand } from "./command-runner.js";
import { roadmapIssueFromJson } from "./authority.js";
import { assertCommand } from "./git-utils.js";
import { BootstrapDependencies, CommandRunner, NextIssueSelection, RoadmapIssue } from "./types.js";

const DEFAULT_ROADMAP_ISSUE = 73;
const NOT_ELIGIBLE_LABELS = new Set(["blocked", "not-ready", "not ready", "on-hold", "on hold", "do-not-run", "do not run"]);

export function unfencedMarkdownLines(text: string): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  let fenceMarker: string | undefined;
  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!fenceMarker) fenceMarker = marker;
      else if (marker === fenceMarker) fenceMarker = undefined;
      continue;
    }
    if (!fenceMarker) result.push(line);
  }
  return result;
}

export function orderedIssueNumbersFromRoadmap(body: string): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const line of unfencedMarkdownLines(body)) {
    const match = line.match(/^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))(?:\[[ xX]\]\s*)?(?:[*_`~]+\s*)?#(\d+)\b/);
    if (!match) continue;
    const number = Number(match[1]);
    if (number === DEFAULT_ROADMAP_ISSUE || seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  if (numbers.length === 0) throw new BootstrapError(`roadmap #${DEFAULT_ROADMAP_ISSUE} contains no ordered issue references`);
  return numbers;
}

export async function fetchRoadmapIssues(cwd: string, runner: CommandRunner = runCommand): Promise<RoadmapIssue[]> {
  const roadmap = await runner("gh", ["issue", "view", String(DEFAULT_ROADMAP_ISSUE), "--json", "number,title,body,comments,state,labels"], { cwd });
  const roadmapIssue = roadmapIssueFromJson(JSON.parse(assertCommand(roadmap, `fetch roadmap #${DEFAULT_ROADMAP_ISSUE}`)));
  const numbers = orderedIssueNumbersFromRoadmap(roadmapIssue.body);
  const issues: RoadmapIssue[] = [];
  for (const number of numbers) {
    const result = await runner("gh", ["issue", "view", String(number), "--json", "number,title,body,comments,state,labels"], { cwd });
    issues.push(roadmapIssueFromJson(JSON.parse(assertCommand(result, `fetch roadmap issue #${number}`))));
  }
  return issues;
}

function dependencyMetadataText(issue: RoadmapIssue): string {
  return [issue.title, issue.body, ...issue.comments.map((comment) => comment.body ?? "")].join("\n");
}

function dependencyLineNoDeps(normalized: string): boolean {
  return /(?:\b(no|none|n\/a)\b.*\b(dependencies?|depends|blocked|required|requires?)\b)|(?:\b(dependencies?|depends|blocked by|required|requires?)\b\s*:?\s*\b(none|no|n\/a)\b)/.test(normalized);
}

function dependencyIssueNumbers(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

export function declaredDependencies(issue: RoadmapIssue): number[] {
  const dependencies = new Set<number>();
  const lines = unfencedMarkdownLines(dependencyMetadataText(issue));
  let declaredNoDependencies = false;

  const recordDependencies = (matches: number[], line: string): void => {
    if (declaredNoDependencies) throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
    for (const dependency of matches) dependencies.add(dependency);
  };
  const recordNoDependencies = (line: string): void => {
    if (dependencies.size > 0) throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
    declaredNoDependencies = true;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(depends on|dependencies?|blocked by|requires?)\b(.*)$/i);
    if (heading) {
      const sectionLines = [heading[2] ?? ""];
      let cursor = index + 1;
      while (cursor < lines.length && !/^\s{0,3}#{1,6}\s+\S/.test(lines[cursor]!)) sectionLines.push(lines[cursor++]!);
      index = cursor - 1;
      const sectionText = sectionLines.join("\n");
      const matches = dependencyIssueNumbers(sectionText);
      const noDeps = dependencyLineNoDeps(`${line.toLowerCase()}\n${sectionText.toLowerCase()}`);
      const meaningfulText = sectionText.replace(/<!--.*?-->/g, "").trim();
      if (matches.length === 0) {
        if (noDeps) { recordNoDependencies(line); continue; }
        throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
      }
      if (noDeps || meaningfulText === "") throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
      recordDependencies(matches, line);
      continue;
    }

    const anchored = line.match(/^\s*(depends on|dependencies?|blocked by|requires?)\s*:\s*(.*?)\s*$/i)
      ?? line.match(/^\s*(depends on|blocked by|requires?)\s+(#\d+\b.*)$/i)
      ?? line.match(/^\s*(dependencies?)\s+(#\d+\b.*)$/i);
    if (!anchored) continue;
    const value = anchored[2] ?? "";
    const noDeps = dependencyLineNoDeps(line.toLowerCase());
    const matches = dependencyIssueNumbers(value);
    if (matches.length === 0) {
      if (noDeps) { recordNoDependencies(line); continue; }
      throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
    }
    if (noDeps) throw new BootstrapError(`ambiguous dependency metadata on #${issue.number}: ${line.trim().slice(0, 120)}`);
    recordDependencies(matches, line);
  }
  dependencies.delete(issue.number);
  return [...dependencies].sort((a, b) => a - b);
}

function notEligibleReason(issue: RoadmapIssue): string | undefined {
  for (const label of issue.labels ?? []) {
    const normalized = label.trim().toLowerCase();
    if (NOT_ELIGIBLE_LABELS.has(normalized)) return `label ${label}`;
  }
  return undefined;
}

export async function resolveNextIssue(cwd: string, dependencies: BootstrapDependencies = {}): Promise<NextIssueSelection> {
  const provider = dependencies.fetchRoadmapIssues ?? ((root: string) => fetchRoadmapIssues(root, dependencies.runCommand ?? runCommand));
  const roadmap = await provider(cwd);
  if (roadmap.length === 0) throw new BootstrapError("roadmap contains no issue candidates");
  const byNumber = new Map<number, RoadmapIssue>();
  for (const item of roadmap) {
    if (byNumber.has(item.number)) throw new BootstrapError(`roadmap contains duplicate issue #${item.number}`);
    byNumber.set(item.number, item);
  }
  const skips = [];
  for (const item of roadmap) {
    if (item.state === "CLOSED") { skips.push({ issueNumber: item.number, status: "closed" as const, reason: "closed" }); continue; }
    const ineligible = notEligibleReason(item);
    if (ineligible) { skips.push({ issueNumber: item.number, status: "not-eligible" as const, reason: ineligible }); continue; }
    const openDependencies = declaredDependencies(item).filter((dependency) => {
      const dependencyIssue = byNumber.get(dependency);
      if (!dependencyIssue) throw new BootstrapError(`dependency #${dependency} for #${item.number} is outside the configured roadmap`);
      return dependencyIssue.state !== "CLOSED";
    });
    if (openDependencies.length > 0) {
      skips.push({ issueNumber: item.number, status: "blocked" as const, reason: `blocked by ${openDependencies.map((number) => `#${number}`).join("/")}` });
      continue;
    }
    return { selectedIssueNumber: item.number, skips };
  }
  return { skips };
}

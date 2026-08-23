export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  untracked: boolean;
}

/**
 * Canonical Git status representation for candidate identity.
 *
 * Always pair this parser with `git status --porcelain=v1 --untracked-files=all` so
 * untracked directories are expanded to the exact files that verification and
 * finalization hand off to each other.
 */
export const CANONICAL_STATUS_ARGS = ["status", "--porcelain=v1", "--untracked-files=all"] as const;

export function parseGitStatusLine(line: string): GitStatusEntry | undefined {
  if (!line) return undefined;
  const match = line.match(/^([ MADRCU?!])([ MADRCU?!]) (.+)$/) ?? line.match(/^([MADRCU?!]) (.+)$/);
  if (!match) return { index: " ", worktree: " ", path: line.split(" -> ").at(-1) ?? line, untracked: false };
  const compact = match.length === 3;
  const index = compact ? " " : match[1]!;
  const worktree = compact ? match[1]! : match[2]!;
  const rawPath = compact ? match[2]! : match[3]!;
  return { index, worktree, path: rawPath.split(" -> ").at(-1) ?? rawPath, untracked: index === "?" && worktree === "?" };
}

export function parseGitStatus(status: string): GitStatusEntry[] {
  return status.split("\n").map(parseGitStatusLine).filter((entry): entry is GitStatusEntry => Boolean(entry));
}

export function uniqueSortedGitPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

export function changedFilePathsFromStatus(status: string): string[] {
  return uniqueSortedGitPaths(parseGitStatus(status).map((entry) => entry.path));
}

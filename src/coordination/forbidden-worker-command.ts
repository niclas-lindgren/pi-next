/**
 * Shared, harness-neutral denylist for worker-facing shell tools.
 *
 * A worker must never be able to reach `main`/authority/destructive git or
 * GitHub state directly through a raw shell, regardless of whether it runs
 * as an in-process SDK session (`src/bootstrap/worker-factory.ts`) or a
 * spawned Pi CLI subprocess (`extensions/pi-next/tools-safe-bash.ts`). Both
 * call this one function so the two enforcement points cannot drift.
 */
export function forbiddenWorkerCommand(command: string): boolean {
  return /(^|[;&|\n])\s*(?:sudo\s+)?(?:gh(?:\s|$)|git\s+(?:push|merge|reset|rebase|worktree|checkout|switch|update-ref)|git\s+branch\s+-[dD]|rm\s+-rf\s+\.git)/i.test(command)
    || /\bgh\s+(?:issue|pr|api)\b/i.test(command);
}

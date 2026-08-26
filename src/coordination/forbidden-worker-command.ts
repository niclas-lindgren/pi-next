import { forbiddenWorkerCommand as commandDeniedByWorkerShellPolicy } from "./worker-shell-policy.js";

/**
 * Backwards-compatible predicate for worker-facing shell tools.
 *
 * The enforcement boundary is now the positive command policy in
 * `worker-shell-policy.ts`: worker commands are parsed and executed without a
 * shell, Git is read-only, GitHub CLI authority is unavailable, nested
 * wrappers/interpreter eval forms are refused before process creation, and
 * repository-controlled build/test launchers run in a detached no-`.git` OS
 * sandbox. Keep this predicate as the shared boolean surface used by existing
 * tests/callers.
 */
export function forbiddenWorkerCommand(command: string): boolean {
  return commandDeniedByWorkerShellPolicy(command);
}

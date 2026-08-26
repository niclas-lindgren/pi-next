import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

import { createWorkerShellExecution, workerShellCommandDecision, type WorkerShellCommandDecision } from "../../src/coordination/worker-shell-policy.ts";

const SAFE_BASH_OUTPUT_LIMIT = 16_000;
const SAFE_BASH_TIMEOUT_MS = 30 * 60 * 1_000;

function runSafeBashCommand(
  cwd: string,
  decision: WorkerShellCommandDecision,
  signal: AbortSignal | undefined,
): Promise<{ output: string; code: number | null }> {
  const sandbox = createWorkerShellExecution(cwd, decision);
  const child = spawn(sandbox.command, sandbox.args, { cwd: sandbox.cwd, env: sandbox.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${String(chunk)}`.slice(-SAFE_BASH_OUTPUT_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const abort = () => child.kill("SIGTERM");
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(() => child.kill("SIGTERM"), SAFE_BASH_TIMEOUT_MS);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timeout);
      sandbox.dispose();
      resolve({ output, code });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      sandbox.dispose();
      resolve({ output: `${output}${error.message}`, code: 127 });
    });
  });
}

/**
 * Replaces Pi's built-in `bash` tool (excluded via `--exclude-tools bash`
 * in `runIssueWorker`) for mutable production workers. The replacement is a
 * positive command runner, not `sh -c`: wrappers, nested shells, interpreter
 * eval forms, GitHub CLI authority, and mutating Git subcommands are refused
 * before process creation. Repository-controlled build/test launchers run in a
 * detached no-`.git` workspace inside an OS mount/network sandbox with
 * Git/GitHub credentials and Git transports stripped (#162).
 *
 * Only registered when `PI_NEXT_ISSUE_WORKER=1` (set exclusively by
 * `runIssueWorker`) so the trusted controller session, which still needs
 * real shell access, is unaffected.
 */
export function registerSafeBashTool(pi: ExtensionAPI) {
  if (process.env.PI_NEXT_ISSUE_WORKER !== "1") return;

  pi.registerTool({
    name: "safe_bash",
    label: "Safe shell",
    description: "Run a repository command in the canonical worktree. Authority, main-branch, and destructive worktree/GitHub operations are refused.",
    promptSnippet: "run a safe repository shell command",
    parameters: Type.Object({ command: Type.String({ description: "The command to run" }) }),
    async execute(_id, params, signal, _update, ctx) {
      const decision = workerShellCommandDecision(params.command);
      if (!decision.allowed || !decision.command) {
        return {
          content: [{ type: "text", text: `Refused: ${decision.reason ?? "command is outside the worker capability policy"}. Use pi_next_git for commits/checkpoints/promotion requests.` }],
          details: { refused: true },
        };
      }
      const result = await runSafeBashCommand(ctx.cwd, decision, signal);
      return {
        content: [{ type: "text", text: `exit ${result.code ?? "signal"}\n${result.output}` }],
        details: { exitCode: result.code },
      };
    },
  });
}

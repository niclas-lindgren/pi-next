import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

import { forbiddenWorkerCommand } from "../../src/coordination/forbidden-worker-command.ts";

const SAFE_BASH_OUTPUT_LIMIT = 16_000;
const SAFE_BASH_TIMEOUT_MS = 30 * 60 * 1_000;

function runSafeBashCommand(
  cwd: string,
  command: string,
  signal: AbortSignal | undefined,
): Promise<{ output: string; code: number | null }> {
  const child = spawn("sh", ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ output, code });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ output: `${output}${error.message}`, code: 127 });
    });
  });
}

/**
 * Replaces Pi's built-in `bash` tool (excluded via `--exclude-tools bash`
 * in `runIssueWorker`) for mutable production workers. Mirrors
 * `src/bootstrap/worker-factory.ts`'s `makeSafeBashTool` so a full Pi CLI
 * subprocess worker gets the same authority/main-branch/destructive-command
 * enforcement as bootstrap's in-process SDK worker, instead of relying only
 * on `pi_next_git`'s narrower action contract while retaining an
 * unrestricted shell (#162).
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
      if (forbiddenWorkerCommand(params.command)) {
        return {
          content: [{ type: "text", text: "Refused: authority, main-branch, or destructive worktree/GitHub command. Use pi_next_git for commits/checkpoints/promotion requests." }],
          details: { refused: true },
        };
      }
      const result = await runSafeBashCommand(ctx.cwd, params.command, signal);
      return {
        content: [{ type: "text", text: `exit ${result.code ?? "signal"}\n${result.output}` }],
        details: { exitCode: result.code },
      };
    },
  });
}

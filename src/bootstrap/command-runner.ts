import { CommandResult, CommandRunner, MAX_OUTPUT } from "./types.js";

function appendOutput(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT) return current;
  return `${current}${chunk.toString()}`.slice(0, MAX_OUTPUT);
}

function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between the timeout and the kill attempt.
  }
}

/** Local worker command execution, adapted from mini-SWE-agent's process-group timeout pattern. */
export const runCommand: CommandRunner = async (command, args, options) => {
  const started = Date.now();
  const child = (await import("node:child_process")).spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  let timedOut = false;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  return await new Promise<CommandResult>((resolvePromise) => {
    const finish = (exitCode: number, signal?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", cancel);
      resolvePromise({
        command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
      });
    };
    const cancel = () => {
      cancelled = true;
      killProcessTree(child.pid ?? 0);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = appendOutput(stderr, error.message);
      finish(127);
    });
    child.once("close", (code, signal) => finish(code ?? 1, signal ?? undefined));
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid ?? 0);
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    }
  });
};

import { stat } from "node:fs/promises";
import { CommandResult, CommandRunner } from "./types.js";
import { BootstrapError } from "./errors.js";
import { redact } from "./utils.js";

export function assertCommand(result: CommandResult, description: string): string {
  if (result.exitCode !== 0) {
    const evidence = redact(result.stderr || result.stdout || `exit ${result.exitCode}`);
    throw new BootstrapError(`${description} failed: ${evidence}`);
  }
  return result.stdout.trim();
}

export async function git(cwd: string, args: string[], runner: CommandRunner): Promise<string> {
  return assertCommand(await runner("git", ["-C", cwd, ...args], { cwd }), `git ${args.join(" ")}`);
}

export async function gitOptional(cwd: string, args: string[], runner: CommandRunner): Promise<CommandResult> {
  return runner("git", ["-C", cwd, ...args], { cwd });
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

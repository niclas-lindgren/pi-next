import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  isWorkerShellProtectedEnvName,
  isWorkerShellSensitiveCredentialName,
  workerShellNormalizeCommandName,
  type WorkerShellCommandDecision,
} from "./worker-shell-policy.js";

export interface WorkerShellEnvironment {
  env: NodeJS.ProcessEnv;
  dispose(): void;
}

export interface WorkerShellExecution extends WorkerShellEnvironment {
  cwd: string;
  command: string;
  args: string[];
}

interface WorkerShellEnvironmentOptions {
  blockRepositoryGit?: boolean;
}

function maybeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathEntries(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

function findOnPath(command: string, pathValue: string | undefined): string | undefined {
  if (command.includes("/") || (process.platform === "win32" && /[\\:]/.test(command))) return command;
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const entry of pathEntries(pathValue)) {
    for (const suffix of suffixes) {
      const candidate = join(entry, `${command}${suffix}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function createBlockedCommandWrappers(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    writeExecutable(join(binDir, "git.cmd"), "@echo off\r\necho pi-next worker sandbox: git is unavailable to repository-controlled commands 1>&2\r\nexit /b 126\r\n");
    writeExecutable(join(binDir, "gh.cmd"), "@echo off\r\necho pi-next worker sandbox: gh is unavailable to repository-controlled commands 1>&2\r\nexit /b 126\r\n");
    return;
  }
  const script = "#!/bin/sh\necho 'pi-next worker sandbox: git/gh is unavailable to repository-controlled commands' >&2\nexit 126\n";
  writeExecutable(join(binDir, "git"), script);
  writeExecutable(join(binDir, "gh"), script);
}

function prepareDetachedWorkspace(cwd: string, root: string): string {
  const workspace = join(root, "workspace");
  cpSync(cwd, workspace, {
    recursive: true,
    dereference: false,
    filter(source) {
      const name = basename(source);
      return name !== ".git" && name !== "node_modules";
    },
  });
  // node_modules is re-attached by the sandbox as a bind mount (preserving
  // symlinks/performance) or, outside an OS sandbox, left for the launcher to
  // create. It never carries the authoritative checkout or its Git metadata.
  mkdirSync(join(workspace, "node_modules"), { recursive: true });
  return workspace;
}

function createWorkerShellEnvironmentRoot(extraEnv: Record<string, string>, baseEnv: NodeJS.ProcessEnv, root: string, options: WorkerShellEnvironmentOptions): NodeJS.ProcessEnv {
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "home", "config"), { recursive: true });
  mkdirSync(join(root, "home", "cache"), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isWorkerShellProtectedEnvName(key)) continue;
    if (isWorkerShellSensitiveCredentialName(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) continue;
    if (isWorkerShellProtectedEnvName(key) || key.toUpperCase() === "PATH") continue;
    if (isWorkerShellSensitiveCredentialName(key)) continue;
    env[key] = value;
  }
  if (!env.PATH && baseEnv.PATH) env.PATH = baseEnv.PATH;
  if (options.blockRepositoryGit) {
    const binDir = join(root, "bin");
    createBlockedCommandWrappers(binDir);
    env.PATH = `${binDir}${delimiter}${env.PATH ?? ""}`;
  }
  env.HOME = join(root, "home");
  env.USERPROFILE = env.HOME;
  env.XDG_CONFIG_HOME = join(root, "home", "config");
  env.XDG_CACHE_HOME = join(root, "home", "cache");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "false";
  env.SSH_ASKPASS = "false";
  env.GCM_INTERACTIVE = "never";
  env.GIT_ALLOW_PROTOCOL = "";
  return env;
}

export function createWorkerShellEnvironment(extraEnv: Record<string, string> = {}, baseEnv: NodeJS.ProcessEnv = process.env, options: WorkerShellEnvironmentOptions = {}): WorkerShellEnvironment {
  const root = mkdtempSync(join(tmpdir(), "pi-next-worker-shell-"));
  const env = createWorkerShellEnvironmentRoot(extraEnv, baseEnv, root, options);
  return {
    env,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function addDirMounts(args: string[], target: string): void {
  const absolute = resolve(target);
  const parts = absolute.split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current += `/${parts[index]}`;
    args.push("--dir", current);
  }
}

function addReadOnlyBindIfPresent(args: string[], path: string): void {
  if (!existsSync(path)) return;
  args.push("--ro-bind", maybeRealpath(path), path);
}

function addPathEntryMount(args: string[], entry: string): void {
  if (!existsSync(entry)) return;
  const real = maybeRealpath(entry);
  if (real.startsWith("/usr/") || real === "/usr" || real.startsWith("/opt/") || real === "/opt") return;
  addDirMounts(args, entry);
  args.push("--ro-bind", real, entry);
}

function createBubblewrapArgs(root: string, cwd: string, sourceCwd: string, command: string, commandArgs: string[], env: NodeJS.ProcessEnv, baseEnv: NodeJS.ProcessEnv): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  const bwrap = findOnPath("bwrap", [baseEnv.PATH, process.env.PATH].filter(Boolean).join(delimiter));
  if (!bwrap) return undefined;
  const resolvedCommand = findOnPath(command, baseEnv.PATH) ?? command;
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
  ];
  addReadOnlyBindIfPresent(args, "/opt");
  addReadOnlyBindIfPresent(args, "/nix");
  if (existsSync("/etc")) args.push("--ro-bind", "/etc", "/etc");
  for (const entry of pathEntries(baseEnv.PATH)) addPathEntryMount(args, entry);
  if (isAbsolute(resolvedCommand) && existsSync(resolvedCommand)) addPathEntryMount(args, dirname(resolvedCommand));
  addDirMounts(args, root);
  args.push("--bind", root, root, "--chdir", cwd);
  const hostNodeModules = join(sourceCwd, "node_modules");
  if (existsSync(hostNodeModules)) {
    // Attach dependencies read-write after the workspace bind so package
    // managers and build tools behave normally. Dependency files cannot reach
    // Git metadata: the authoritative checkout is not part of this namespace.
    args.push("--bind", maybeRealpath(hostNodeModules), join(cwd, "node_modules"));
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push("--setenv", key, value);
  }
  args.push(resolvedCommand, ...commandArgs);
  return [bwrap, args].flat();
}

function createSandboxUnavailable(root: string): string {
  const path = join(root, process.platform === "win32" ? "sandbox-unavailable.cmd" : "sandbox-unavailable");
  if (process.platform === "win32") {
    writeExecutable(path, "@echo off\r\necho pi-next worker sandbox: repository-controlled commands require an OS sandbox 1>&2\r\nexit /b 126\r\n");
  } else {
    writeExecutable(path, "#!/bin/sh\necho 'pi-next worker sandbox: repository-controlled commands require bubblewrap' >&2\nexit 126\n");
  }
  return path;
}

export function createWorkerShellExecution(cwd: string, decision: WorkerShellCommandDecision, baseEnv: NodeJS.ProcessEnv = process.env): WorkerShellExecution {
  if (!decision.allowed || !decision.command) throw new Error(decision.reason ?? "command is outside the worker capability policy");
  const root = mkdtempSync(join(tmpdir(), "pi-next-worker-exec-"));
  const detached = decision.workspaceMode === "detached";
  const executionCwd = detached ? prepareDetachedWorkspace(cwd, root) : cwd;
  const env = createWorkerShellEnvironmentRoot(decision.env ?? {}, baseEnv, root, { blockRepositoryGit: detached });
  env.PWD = executionCwd;
  let command = decision.command;
  let args = [...(decision.args ?? [])];
  if (detached) {
    const sandboxArgs = createBubblewrapArgs(root, executionCwd, cwd, decision.command, args, env, baseEnv);
    if (sandboxArgs) {
      command = sandboxArgs[0]!;
      args = sandboxArgs.slice(1);
    } else {
      command = createSandboxUnavailable(root);
      args = [];
    }
  }
  return {
    cwd: executionCwd,
    command,
    args,
    env,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

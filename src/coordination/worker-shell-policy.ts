import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface WorkerShellCommandDecision {
  allowed: boolean;
  reason?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface WorkerShellEnvironment {
  env: NodeJS.ProcessEnv;
  dispose(): void;
}

const UNSAFE_LAUNCHERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "python",
  "python2",
  "python3",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "env",
  "sudo",
  "su",
  "xargs",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "grep",
  "ls-files",
  "rev-parse",
  "blame",
  "describe",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "corepack"]);
const TEST_AND_BUILD_TOOLS = new Set([
  "make",
  "node",
  "tsx",
  "ts-node",
  "tsc",
  "jest",
  "vitest",
  "mocha",
  "eslint",
  "prettier",
  "cargo",
  "rustc",
  "go",
]);
const INSPECTION_TOOLS = new Set(["echo", "pwd", "ls", "cat", "grep", "rg", "head", "tail", "wc", "sort", "uniq"]);

const PROTECTED_ENV_PREFIXES = [
  "GIT_",
  "GH_",
  "GITHUB_",
  "SSH_",
  "GCM_",
  "LD_",
  "DYLD_",
];
const PROTECTED_ENV_NAMES = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "NPM_TOKEN",
]);

function normalizeCommandName(command: string): string {
  return basename(command).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isProtectedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_ENV_NAMES.has(upper) || PROTECTED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function containsShellControlOutsideQuotes(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "<" || char === ">" || char === "`" || char === "\n" || char === "\r") return true;
  }
  return false;
}

function splitCommandLine(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  if (escaped || quote) return undefined;
  flush();
  return tokens;
}

function allowsNpmLikeCommand(base: string, args: string[]): boolean {
  if (base === "corepack") return args.length > 0 && PACKAGE_MANAGERS.has(normalizeCommandName(args[0]!));
  if (base === "yarn") return !["npm", "publish", "login", "logout", "config", "token"].includes(args[0] ?? "");
  if (base === "pnpm") return !["publish", "login", "logout", "config", "token", "dlx"].includes(args[0] ?? "");
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return subcommand === "" || ["test", "run", "run-script", "install", "ci", "list", "ls", "outdated", "audit", "build"].includes(subcommand);
}

function allowsNodeCommand(args: string[]): boolean {
  return !args.some((arg) => ["-e", "--eval", "-p", "--print", "--interactive"].includes(arg));
}

function allowsFindCommand(args: string[]): boolean {
  return !args.some((arg) => ["-exec", "-execdir", "-delete"].includes(arg));
}

function gitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("-c")) continue;
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

/**
 * Authorize one worker-facing command without invoking a shell. The policy is
 * intentionally positive: command chaining, wrappers, nested shells and
 * interpreter eval forms are rejected before process creation. Git is limited
 * to read-only inspection subcommands; GitHub CLI authority is not exposed.
 */
export function workerShellCommandDecision(command: string): WorkerShellCommandDecision {
  if (command.trim().length === 0) return { allowed: false, reason: "empty command" };
  if (containsShellControlOutsideQuotes(command)) return { allowed: false, reason: "shell control operators are not available in worker shell" };
  const tokens = splitCommandLine(command);
  if (!tokens || tokens.length === 0) return { allowed: false, reason: "could not parse command safely" };

  const env: Record<string, string> = {};
  while (tokens.length > 0 && isEnvAssignment(tokens[0]!)) {
    const token = tokens.shift()!;
    const separator = token.indexOf("=");
    const name = token.slice(0, separator);
    if (isProtectedEnvName(name)) return { allowed: false, reason: `protected environment override refused: ${name}` };
    env[name] = token.slice(separator + 1);
  }
  const executable = tokens.shift();
  if (!executable) return { allowed: false, reason: "missing executable" };
  const base = normalizeCommandName(executable);
  const args = tokens;

  if (base === "gh") return { allowed: false, reason: "GitHub authority is controller-owned" };
  if (UNSAFE_LAUNCHERS.has(base)) return { allowed: false, reason: `${base} can bypass worker authority controls` };
  if (base === "git") {
    const subcommand = gitSubcommand(args);
    if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      return { allowed: false, reason: "git is limited to read-only inspection subcommands" };
    }
    return { allowed: true, command: executable, args, env };
  }
  if (base === "rm") return { allowed: false, reason: "destructive file removal is not available through worker shell" };
  if (base === "find" && !allowsFindCommand(args)) return { allowed: false, reason: "find execution/deletion actions are refused" };
  if (PACKAGE_MANAGERS.has(base)) {
    if (!allowsNpmLikeCommand(base, args)) return { allowed: false, reason: `${base} subcommand is outside the build/test allowlist` };
    return { allowed: true, command: executable, args, env };
  }
  if (base === "node" && !allowsNodeCommand(args)) return { allowed: false, reason: "node eval/print forms can bypass worker authority controls" };
  if (TEST_AND_BUILD_TOOLS.has(base) || INSPECTION_TOOLS.has(base) || base === "find") {
    return { allowed: true, command: executable, args, env };
  }
  return { allowed: false, reason: `${base} is outside the worker command allowlist` };
}

export function forbiddenWorkerCommand(command: string): boolean {
  return !workerShellCommandDecision(command).allowed;
}

export function createWorkerShellEnvironment(extraEnv: Record<string, string> = {}, baseEnv: NodeJS.ProcessEnv = process.env): WorkerShellEnvironment {
  const home = mkdtempSync(join(tmpdir(), "pi-next-worker-shell-"));
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "cache"), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isProtectedEnvName(key)) continue;
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && /GITHUB|GH|GIT|SSH|HUB/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, extraEnv);
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, "config");
  env.XDG_CACHE_HOME = join(home, "cache");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "false";
  env.SSH_ASKPASS = "false";
  env.GCM_INTERACTIVE = "never";
  env.GIT_ALLOW_PROTOCOL = "";
  return {
    env,
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

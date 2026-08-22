import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { BootstrapSetupError } from "./errors.js";
import { CommandRunner, DependencyManager, DependencySetupReport } from "./types.js";
import { redact } from "./utils.js";
import { isDirectory } from "./git-utils.js";

interface DependencySpec {
  manager: DependencyManager;
  lockfile: string;
  validateArgs: string[];
  installArgs: string[];
}

const DEPENDENCY_STATE_FILE = ".pi-next-dependency-state.json";

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function dependencyFingerprint(cwd: string, lockfile: string): Promise<string> {
  const packageJson = await readFile(resolve(cwd, "package.json"));
  const lock = await readFile(resolve(cwd, lockfile));
  return createHash("sha256").update(packageJson).update("\0").update(lock).digest("hex");
}

async function dependencyState(cwd: string): Promise<{ manager: DependencyManager; lockfile: string; fingerprint: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(resolve(cwd, "node_modules", DEPENDENCY_STATE_FILE), "utf8")) as Partial<{
      manager: DependencyManager;
      lockfile: string;
      fingerprint: string;
    }>;
    if (typeof value.manager !== "string" || typeof value.lockfile !== "string" || typeof value.fingerprint !== "string") return undefined;
    return value as { manager: DependencyManager; lockfile: string; fingerprint: string };
  } catch {
    return undefined;
  }
}

async function recordDependencyState(cwd: string, spec: DependencySpec, fingerprint: string): Promise<void> {
  await writeFile(resolve(cwd, "node_modules", DEPENDENCY_STATE_FILE), JSON.stringify({
    version: 1,
    manager: spec.manager,
    lockfile: spec.lockfile,
    fingerprint,
  }) + "\n");
}

async function dependencySpec(cwd: string): Promise<DependencySpec | undefined> {
  let packageManager: string | undefined;
  try {
    const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as { packageManager?: unknown };
    if (typeof packageJson.packageManager === "string") packageManager = packageJson.packageManager.split("@")[0];
  } catch {
    // A lockfile below is still enough to select a deterministic installer.
  }
  const candidates: Array<[DependencyManager, string, string[], string[]]> = [
    ["npm", "package-lock.json", ["ls", "--all", "--json", "--silent"], ["ci"]],
    ["pnpm", "pnpm-lock.yaml", ["list", "--recursive", "--depth", "Infinity", "--json"], ["install", "--frozen-lockfile"]],
    ["yarn", "yarn.lock", ["check", "--integrity"], ["install", "--frozen-lockfile"]],
  ];
  const ordered = packageManager
    ? [...candidates].sort(([manager]) => manager === packageManager ? -1 : 1)
    : candidates;
  for (const [manager, lockfile, validateArgs, installArgs] of ordered) {
    if (await stat(resolve(cwd, lockfile)).then((entry) => entry.isFile()).catch(() => false)) {
      return { manager, lockfile, validateArgs, installArgs };
    }
  }
  return undefined;
}

export async function prepareDependencies(
  cwd: string,
  runner: CommandRunner,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DependencySetupReport> {
  const spec = await dependencySpec(cwd);
  if (!spec) return { action: "not-required" };

  const nodeModules = resolve(cwd, "node_modules");
  const fingerprint = await dependencyFingerprint(cwd, spec.lockfile);
  const recorded = await dependencyState(cwd);
  const reusable = await isDirectory(nodeModules) && !(await isSymlink(nodeModules));
  const sameInputs = recorded?.manager === spec.manager && recorded.lockfile === spec.lockfile && recorded.fingerprint === fingerprint;
  if (reusable && (recorded === undefined || sameInputs)) {
    const validation = await runner(spec.manager, spec.validateArgs, { cwd, timeoutMs, signal });
    if (validation.exitCode === 0) {
      try {
        await recordDependencyState(cwd, spec, fingerprint);
      } catch {
        // The validated installation is still usable.
      }
      return { manager: spec.manager, lockfile: spec.lockfile, action: "reused" };
    }
  }

  const installed = await runner(spec.manager, spec.installArgs, { cwd, timeoutMs, signal });
  if (installed.exitCode !== 0) {
    const evidence = redact(installed.stderr || installed.stdout || `exit ${installed.exitCode}`);
    throw new BootstrapSetupError(`${spec.manager} dependency setup failed for ${spec.lockfile}: ${evidence}`);
  }
  try {
    await recordDependencyState(cwd, spec, fingerprint);
  } catch {
    // State is an optimization.
  }
  return { manager: spec.manager, lockfile: spec.lockfile, action: "installed" };
}

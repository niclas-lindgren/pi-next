import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkerToolPathDecision {
  allowed: boolean;
  reason?: string;
  relativePath?: string;
}

export interface WorkerToolPathDecisionOptions {
  role?: string;
}

const PROTECTED_REPO_METADATA_SEGMENTS = new Set([".git", ".hg", ".svn"]);
const PROTECTED_RUNTIME_PREFIXES = [
  ".pi/runtime/",
  ".pi/logs/",
  ".pi-next/runtime/",
];

function relativeTo(base: string, target: string): { relativePath: string; outside: boolean } {
  const rel = relative(resolve(base), resolve(target)).split(sep).join("/");
  return { relativePath: rel || ".", outside: rel === ".." || rel.startsWith("../") || isAbsolute(rel) };
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function toRepoRelativePath(cwd: string, inputPath: string): { relativePath: string; outside: boolean; realOutside: boolean; realRelativePath?: string } {
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const lexical = relativeTo(cwd, absolute);
  let realOutside = false;
  let realRelativePath: string | undefined;
  try {
    const realBase = realpathSync(cwd);
    const realAncestor = realpathSync(nearestExistingPath(absolute));
    const real = relativeTo(realBase, realAncestor);
    realOutside = real.outside;
    realRelativePath = real.relativePath;
  } catch {
    realOutside = false;
  }
  return { ...lexical, realOutside, ...(realRelativePath ? { realRelativePath } : {}) };
}

function maintenanceRuntimeWriteAllowed(role: string | undefined, relativePath: string): boolean {
  return role === "maintenance" && relativePath === ".pi/runtime/pi-next-loop-maintenance-result.json";
}

export function workerToolPathDecision(cwd: string, inputPath: unknown, options: WorkerToolPathDecisionOptions = {}): WorkerToolPathDecision {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return { allowed: false, reason: "worker file tool path must be a non-empty string" };
  }
  const { relativePath, outside, realOutside, realRelativePath } = toRepoRelativePath(cwd, inputPath);
  if (outside || realOutside) {
    return { allowed: false, reason: "worker file tools are confined to the canonical workspace", relativePath };
  }
  const segments = [relativePath, realRelativePath ?? ""].flatMap((path) => path.split("/").filter(Boolean));
  if (segments.some((segment) => PROTECTED_REPO_METADATA_SEGMENTS.has(segment))) {
    return { allowed: false, reason: "worker file tools may not mutate repository metadata", relativePath };
  }
  const normalized = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
  const realNormalized = realRelativePath ? (realRelativePath.endsWith("/") ? realRelativePath : `${realRelativePath}/`) : "";
  if (PROTECTED_RUNTIME_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix) || realNormalized === prefix || realNormalized.startsWith(prefix))) {
    const role = options.role ?? process.env.PI_NEXT_WORKER_ROLE;
    if (!maintenanceRuntimeWriteAllowed(role, relativePath)) {
      return { allowed: false, reason: "worker file tools may not forge runtime authority, telemetry, or result records", relativePath };
    }
  }
  return { allowed: true, relativePath };
}

function pathForMutationTool(event: { toolName: string; input: unknown }): unknown {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const input = event.input as Record<string, unknown>;
  return input.path ?? input.file_path;
}

/**
 * Defense-in-depth for isolated issue workers. Pi CLI tool allowlisting removes
 * raw bash, while this event guard prevents the remaining built-in mutation
 * tools from writing Git metadata, shared runtime authority records, or paths
 * outside the canonical workspace. Lifecycle tools such as pi_next_git and
 * pi_next_update remain the only worker-callable way to checkpoint, request
 * promotion, or record loop state.
 */
export function registerWorkerCapabilityGuards(pi: ExtensionAPI) {
  if (process.env.PI_NEXT_ISSUE_WORKER !== "1") return;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return {
        block: true,
        reason: "raw bash is not available to pi-next issue workers; use safe_bash for allowed repository commands",
        terminate: false,
      };
    }
    const target = pathForMutationTool(event);
    if (target === undefined) return undefined;
    const decision = workerToolPathDecision(ctx.cwd, target, { role: process.env.PI_NEXT_WORKER_ROLE });
    if (!decision.allowed) {
      return {
        block: true,
        reason: decision.reason,
        terminate: false,
      };
    }
    return undefined;
  });
}

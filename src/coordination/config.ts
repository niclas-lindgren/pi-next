/**
 * Versioned, project-owned pi-next configuration.
 *
 * The core never infers product policy from a repository layout.  A missing
 * file gets conservative, generic defaults; an invalid file fails before a
 * workflow can mutate state.  Configuration is JSON deliberately so it can be
 * parsed without adding a runtime dependency to the Pi package.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export const PI_NEXT_CONFIG_VERSION = 1 as const;
export const PI_NEXT_CONFIG_PATH = ".pi-next/config.json" as const;

export interface PiNextConfig {
  version: typeof PI_NEXT_CONFIG_VERSION;
  authority: {
    adapter: string;
    projectStatus: {
      todo: string;
      inProgress: string;
      done: string;
      blocked: string;
    };
  };
  selection: {
    priorities: string[];
    readyStates: string[];
    blockedStates: string[];
  };
  repositoryPolicy: {
    entrypoints: string[];
  };
  workflow: {
    stateDir: string;
    planPath: string;
    verifyPath: string;
    archiveDir: string;
    deferredDir: string;
    skillPath: string;
    tuningPath: string;
    helperDir: string;
  };
}

/** Defaults contain no product name, domain policy, or hidden consumer path. */
export const DEFAULT_PI_NEXT_CONFIG: Readonly<PiNextConfig> = Object.freeze({
  version: PI_NEXT_CONFIG_VERSION,
  authority: {
    adapter: "github",
    projectStatus: { todo: "Todo", inProgress: "In Progress", done: "Done", blocked: "Blocked" },
  },
  selection: {
    priorities: ["P0", "P1", "P2", "P3"],
    readyStates: ["ready"],
    blockedStates: ["blocked"],
  },
  repositoryPolicy: { entrypoints: [] },
  workflow: {
    stateDir: ".pi-next",
    planPath: ".pi-next/PLAN.md",
    verifyPath: ".pi-next/VERIFY.md",
    archiveDir: ".pi-next/ARCHIVED",
    deferredDir: ".pi-next/deferred",
    skillPath: ".pi-next/SKILL.md",
    tuningPath: ".pi-next/LOOP_TUNING.md",
    helperDir: ".pi-next/scripts",
  },
});

export class PiNextConfigError extends Error {
  readonly code = "invalid_pi_next_config";
  constructor(message: string) {
    super(message);
    this.name = "PiNextConfigError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiNextConfigError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PiNextConfigError(`${name}.${key} is not supported`);
  }
}

function strings(value: unknown, name: string, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new PiNextConfigError(`${name} must be a non-empty string array with at most ${max} entries`);
  }
  return value.map((item) => (item as string).trim());
}

function pathValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) || value.includes("\0")) {
    throw new PiNextConfigError(`${name} must be a non-empty relative path`);
  }
  const cleaned = normalize(value.trim()).replaceAll("\\", "/");
  if (cleaned === "." || cleaned.split("/").includes("..")) {
    throw new PiNextConfigError(`${name} must stay inside the repository`);
  }
  return cleaned;
}

function cloneDefaults(): PiNextConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PI_NEXT_CONFIG)) as PiNextConfig;
}

export function validatePiNextConfig(value: unknown): PiNextConfig {
  const root = object(value, "config");
  rejectUnknown(root, ["version", "authority", "selection", "repositoryPolicy", "workflow"], "config");
  if (root.version !== PI_NEXT_CONFIG_VERSION) {
    throw new PiNextConfigError(`config.version must be ${PI_NEXT_CONFIG_VERSION}`);
  }

  const authority = object(root.authority, "config.authority");
  rejectUnknown(authority, ["adapter", "projectStatus"], "config.authority");
  if (typeof authority.adapter !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(authority.adapter.trim())) {
    throw new PiNextConfigError("config.authority.adapter must be a supported adapter name");
  }
  const projectStatus = authority.projectStatus === undefined
    ? DEFAULT_PI_NEXT_CONFIG.authority.projectStatus
    : object(authority.projectStatus, "config.authority.projectStatus");
  rejectUnknown(projectStatus, ["todo", "inProgress", "done", "blocked"], "config.authority.projectStatus");
  const statusValues = {
    todo: projectStatus.todo,
    inProgress: projectStatus.inProgress,
    done: projectStatus.done,
    blocked: projectStatus.blocked,
  };
  for (const [key, value] of Object.entries(statusValues)) {
    if (typeof value !== "string" || !value.trim()) throw new PiNextConfigError(`config.authority.projectStatus.${key} must be a non-empty string`);
  }
  const normalizedStatusValues = {
    todo: String(statusValues.todo).trim(),
    inProgress: String(statusValues.inProgress).trim(),
    done: String(statusValues.done).trim(),
    blocked: String(statusValues.blocked).trim(),
  };

  const selection = object(root.selection, "config.selection");
  rejectUnknown(selection, ["priorities", "readyStates", "blockedStates"], "config.selection");
  const priorities = strings(selection.priorities, "config.selection.priorities");
  const readyStates = strings(selection.readyStates, "config.selection.readyStates");
  const blockedStates = strings(selection.blockedStates, "config.selection.blockedStates");

  const policy = object(root.repositoryPolicy, "config.repositoryPolicy");
  rejectUnknown(policy, ["entrypoints"], "config.repositoryPolicy");
  const entrypoints = strings(policy.entrypoints, "config.repositoryPolicy.entrypoints");
  entrypoints.forEach((entry) => pathValue(entry, "config.repositoryPolicy.entrypoints[]"));

  const workflow = object(root.workflow, "config.workflow");
  const workflowKeys = ["stateDir", "planPath", "verifyPath", "archiveDir", "deferredDir", "skillPath", "tuningPath", "helperDir"] as const;
  rejectUnknown(workflow, workflowKeys, "config.workflow");
  const paths = Object.fromEntries(workflowKeys.map((key) => [key, pathValue(workflow[key], `config.workflow.${key}`)])) as PiNextConfig["workflow"];

  return {
    version: PI_NEXT_CONFIG_VERSION,
    authority: {
      adapter: authority.adapter.trim(),
      projectStatus: {
        ...normalizedStatusValues,
      },
    },
    selection: { priorities, readyStates, blockedStates },
    repositoryPolicy: { entrypoints },
    workflow: paths,
  };
}

/** Load and validate project configuration. Missing config is intentionally safe. */
export function loadPiNextConfig(cwd: string): PiNextConfig {
  const configured = process.env.PI_NEXT_CONFIG?.trim();
  const path = configured
    ? (isAbsolute(configured) ? configured : join(cwd, configured))
    : join(cwd, PI_NEXT_CONFIG_PATH);
  if (!existsSync(path)) return cloneDefaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PiNextConfigError(`cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePiNextConfig(parsed);
}

export function configuredPath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const result = resolve(root, path);
  const rel = relative(root, result);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PiNextConfigError(`configured path escapes repository: ${path}`);
  return result;
}

export function repositoryPolicyText(config: PiNextConfig): string {
  return config.repositoryPolicy.entrypoints.length
    ? `Repository policy entrypoints (authoritative): ${config.repositoryPolicy.entrypoints.join(", ")}.`
    : "No repository policy entrypoint is configured; do not invent one.";
}

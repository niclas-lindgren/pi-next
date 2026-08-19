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
import type { WorkerModelPolicy, WorkerRole } from "./worker-dispatch.ts";

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
  workerDispatch: {
    version: 1;
    models: Partial<Record<WorkerRole, WorkerModelPolicy>>;
    maxEscalations: number;
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
  workerDispatch: { version: 1 as const, models: {}, maxEscalations: 2 },
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
  rejectUnknown(root, ["version", "authority", "selection", "repositoryPolicy", "workflow", "workerDispatch"], "config");
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

  const dispatchValue = root.workerDispatch === undefined
    ? DEFAULT_PI_NEXT_CONFIG.workerDispatch
    : object(root.workerDispatch, "config.workerDispatch");
  rejectUnknown(dispatchValue, ["version", "models", "maxEscalations"], "config.workerDispatch");
  if (dispatchValue.version !== 1) throw new PiNextConfigError("config.workerDispatch.version must be 1");
  const modelsValue = dispatchValue.models === undefined ? {} : object(dispatchValue.models, "config.workerDispatch.models");
  const models: Partial<Record<WorkerRole, WorkerModelPolicy>> = {};
  for (const [role, raw] of Object.entries(modelsValue)) {
    if (!/^(controller|planning|implementation|repair|review-spec|review-standards|verification|maintenance)$/.test(role)) {
      throw new PiNextConfigError(`config.workerDispatch.models.${role} is not a supported worker role`);
    }
    const model = object(raw, `config.workerDispatch.models.${role}`);
    rejectUnknown(model, ["model", "thinking", "escalation"], `config.workerDispatch.models.${role}`);
    if (model.model !== undefined && (typeof model.model !== "string" || !model.model.trim())) throw new PiNextConfigError(`config.workerDispatch.models.${role}.model must be a non-empty string`);
    const thinking = model.thinking;
    if (thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking))) throw new PiNextConfigError(`config.workerDispatch.models.${role}.thinking is unsupported`);
    if (model.escalation !== undefined && (!Number.isInteger(model.escalation) || Number(model.escalation) < 0 || Number(model.escalation) > 3)) throw new PiNextConfigError(`config.workerDispatch.models.${role}.escalation must be between 0 and 3`);
    models[role as WorkerRole] = { ...(model.model === undefined ? {} : { model: String(model.model).trim() }), ...(thinking === undefined ? {} : { thinking: thinking as WorkerModelPolicy["thinking"] }), ...(model.escalation === undefined ? {} : { escalation: Number(model.escalation) }) };
  }
  const maxEscalationsRaw = dispatchValue.maxEscalations === undefined ? 2 : dispatchValue.maxEscalations;
  if (typeof maxEscalationsRaw !== "number" || !Number.isInteger(maxEscalationsRaw) || maxEscalationsRaw < 0 || maxEscalationsRaw > 3) throw new PiNextConfigError("config.workerDispatch.maxEscalations must be between 0 and 3");
  const maxEscalations = maxEscalationsRaw;

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
    workerDispatch: { version: 1, models, maxEscalations: Number(maxEscalations) },
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

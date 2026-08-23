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
import type { AdversarialReviewPolicy, ReviewAxis } from "./adversarial-review.ts";
import {
  DEFAULT_SKILL_ROUTING_POLICY,
  RISK_CLASSES,
  SKILL_ROUTING_POLICY_VERSION,
  SkillRegistryError,
  builtInSkillRegistry,
  validateSkillRoutingPolicy,
  type RiskClass,
  type SkillAutomaticRule,
  type SkillMandatoryRule,
  type SkillRoutingPolicy,
} from "./skill-registry.ts";

const WORKER_ROLE_PATTERN = /^(controller|planning|implementation|repair|review-spec|review-standards|verification|maintenance)$/;

export const PI_NEXT_CONFIG_VERSION = 1 as const;
export const PI_NEXT_CONFIG_PATH = ".pi-next/config.json" as const;

export interface WorkerWatchdogPolicy {
  softIdleMs: number;
  hardIdleMs: number;
  hardWallMs: number;
  terminationGraceMs: number;
}

export interface WorkerWatchdogPolicyConfig {
  default: WorkerWatchdogPolicy;
  roles: Partial<Record<WorkerRole, WorkerWatchdogPolicy>>;
}

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
    stateProvider: {
      type: "builtin" | "helper";
      path?: string;
    };
    archiveDir: string;
    deferredDir: string;
    skillPath: string;
    tuningPath: string;
    diagnosticsPath: string;
    helperDir: string;
  };
  workerDispatch: {
    version: 1;
    models: Partial<Record<WorkerRole, WorkerModelPolicy>>;
    maxEscalations: number;
  };
  /** Versioned, validated skill routing policy (mandatory/automatic/explicit). */
  skills: SkillRoutingPolicy;
  adversarialReview: AdversarialReviewPolicy;
  convergence: {
    softTransitions: number;
    hardTransitions: number;
    softWallMs: number;
    hardWallMs: number;
    /** Cumulative provider totalTokens minus the explicit budget baseline. */
    softTokens: number;
    hardTokens: number;
    maxPlanTasksWarning: number;
  };
  workerWatchdog: WorkerWatchdogPolicyConfig;
  monitor: {
    pollIntervalMs: number;
    maxBackoffMs: number;
  };
  /** Bounded self-assessment policy. Runtime changes remain disabled outside
   * explicitly configured/reversible actions. */
  assessment: {
    enabled: boolean;
    noProgressThreshold: number;
    repeatedFailureThreshold: number;
    repeatedCommandThreshold: number;
    contextPressureThreshold: number;
    findingRecurrenceThreshold: number;
    findingMinConfidence: "low" | "medium" | "high";
    findingLabels: string[];
    heldStates: string[];
    approvedStates: string[];
    rejectedStates: string[];
    supersededStates: string[];
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
    stateProvider: { type: "builtin" as const },
    archiveDir: ".pi-next/ARCHIVED",
    deferredDir: ".pi-next/deferred",
    skillPath: ".pi-next/SKILL.md",
    tuningPath: ".pi-next/LOOP_TUNING.md",
    diagnosticsPath: ".pi-next/diagnostics",
    helperDir: ".pi-next/scripts",
  },
  workerDispatch: { version: 1 as const, models: {}, maxEscalations: 2 },
  skills: JSON.parse(JSON.stringify(DEFAULT_SKILL_ROUTING_POLICY)) as SkillRoutingPolicy,
  adversarialReview: { enabled: false, requiredRisk: "high" as const, maxRounds: 2, axes: ["spec", "standards"] as ReviewAxis[] },
  convergence: {
    softTransitions: 6,
    hardTransitions: 12,
    softWallMs: 15 * 60_000,
    hardWallMs: 30 * 60_000,
    // Provider-reported totalTokens is retained as the bounded fairness
    // metric, but defaults allow several ordinary worker turns (#62).
    softTokens: 2_000_000,
    hardTokens: 4_000_000,
    maxPlanTasksWarning: 12,
  },
  workerWatchdog: {
    default: { softIdleMs: 120_000, hardIdleMs: 600_000, hardWallMs: 2_700_000, terminationGraceMs: 5_000 },
    roles: {
      verification: { softIdleMs: 180_000, hardIdleMs: 900_000, hardWallMs: 3_600_000, terminationGraceMs: 5_000 },
    },
  },
  monitor: { pollIntervalMs: 60_000, maxBackoffMs: 600_000 },
  assessment: {
    enabled: true,
    noProgressThreshold: 2,
    repeatedFailureThreshold: 2,
    repeatedCommandThreshold: 2,
    contextPressureThreshold: 0.85,
    findingRecurrenceThreshold: 3,
    findingMinConfidence: "high" as const,
    findingLabels: ["agent:finding"],
    heldStates: ["status:needs-review"],
    approvedStates: ["approved", "ready"],
    rejectedStates: ["rejected"],
    supersededStates: ["superseded", "duplicate"],
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

function riskArray(value: unknown, name: string): RiskClass[] {
  const list = strings(value, name, RISK_CLASSES.length);
  for (const risk of list) {
    if (!(RISK_CLASSES as readonly string[]).includes(risk)) throw new PiNextConfigError(`${name} contains an unsupported risk class: ${risk}`);
  }
  return list as RiskClass[];
}

function roleArray(value: unknown, name: string): WorkerRole[] {
  const list = strings(value, name, 8);
  for (const role of list) {
    if (!WORKER_ROLE_PATTERN.test(role)) throw new PiNextConfigError(`${name} contains an unsupported worker role: ${role}`);
  }
  return list as WorkerRole[];
}

function parseSkillsPolicy(value: unknown): SkillRoutingPolicy {
  if (value === undefined) return JSON.parse(JSON.stringify(DEFAULT_SKILL_ROUTING_POLICY)) as SkillRoutingPolicy;
  const root = object(value, "config.skills");
  rejectUnknown(root, ["version", "mandatory", "automatic", "explicit"], "config.skills");
  if (root.version !== SKILL_ROUTING_POLICY_VERSION) throw new PiNextConfigError(`config.skills.version must be ${SKILL_ROUTING_POLICY_VERSION}`);

  const mandatoryRaw = root.mandatory === undefined ? [] : root.mandatory;
  if (!Array.isArray(mandatoryRaw) || mandatoryRaw.length > 32) throw new PiNextConfigError("config.skills.mandatory must be an array with at most 32 entries");
  const mandatory: SkillMandatoryRule[] = mandatoryRaw.map((raw, index) => {
    const rule = object(raw, `config.skills.mandatory[${index}]`);
    rejectUnknown(rule, ["skill", "roles", "risk", "reason"], `config.skills.mandatory[${index}]`);
    if (typeof rule.skill !== "string" || !rule.skill.trim()) throw new PiNextConfigError(`config.skills.mandatory[${index}].skill must be a non-empty string`);
    return {
      skill: rule.skill.trim(),
      ...(rule.roles === undefined ? {} : { roles: roleArray(rule.roles, `config.skills.mandatory[${index}].roles`) }),
      ...(rule.risk === undefined ? {} : { risk: riskArray(rule.risk, `config.skills.mandatory[${index}].risk`) }),
      ...(rule.reason === undefined ? {} : { reason: String(rule.reason).trim() }),
    };
  });

  const automaticRaw = root.automatic === undefined ? [] : root.automatic;
  if (!Array.isArray(automaticRaw) || automaticRaw.length > 64) throw new PiNextConfigError("config.skills.automatic must be an array with at most 64 entries");
  const automatic: SkillAutomaticRule[] = automaticRaw.map((raw, index) => {
    const rule = object(raw, `config.skills.automatic[${index}]`);
    rejectUnknown(rule, ["skill", "roles", "risk", "taskPattern", "paths", "reason"], `config.skills.automatic[${index}]`);
    if (typeof rule.skill !== "string" || !rule.skill.trim()) throw new PiNextConfigError(`config.skills.automatic[${index}].skill must be a non-empty string`);
    if (rule.taskPattern !== undefined) {
      if (typeof rule.taskPattern !== "string" || !rule.taskPattern.trim() || rule.taskPattern.length > 200) throw new PiNextConfigError(`config.skills.automatic[${index}].taskPattern must be a bounded non-empty string`);
      try {
        new RegExp(rule.taskPattern, "i");
      } catch {
        throw new PiNextConfigError(`config.skills.automatic[${index}].taskPattern is not a valid regular expression`);
      }
    }
    return {
      skill: rule.skill.trim(),
      ...(rule.roles === undefined ? {} : { roles: roleArray(rule.roles, `config.skills.automatic[${index}].roles`) }),
      ...(rule.risk === undefined ? {} : { risk: riskArray(rule.risk, `config.skills.automatic[${index}].risk`) }),
      ...(rule.taskPattern === undefined ? {} : { taskPattern: String(rule.taskPattern) }),
      ...(rule.paths === undefined ? {} : { paths: strings(rule.paths, `config.skills.automatic[${index}].paths`, 32) }),
      ...(rule.reason === undefined ? {} : { reason: String(rule.reason).trim() }),
    };
  });

  const explicit = root.explicit === undefined ? [] : strings(root.explicit, "config.skills.explicit", 64);
  const policy: SkillRoutingPolicy = { version: SKILL_ROUTING_POLICY_VERSION, mandatory, automatic, explicit };
  try {
    validateSkillRoutingPolicy(policy, builtInSkillRegistry());
  } catch (error) {
    if (error instanceof SkillRegistryError) throw new PiNextConfigError(error.message);
    throw error;
  }
  return policy;
}

export function validatePiNextConfig(value: unknown): PiNextConfig {
  const root = object(value, "config");
  rejectUnknown(root, ["version", "authority", "selection", "repositoryPolicy", "workflow", "workerDispatch", "skills", "adversarialReview", "convergence", "workerWatchdog", "monitor", "assessment"], "config");
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
  const workflowKeys = ["stateDir", "planPath", "verifyPath", "archiveDir", "deferredDir", "skillPath", "tuningPath", "diagnosticsPath", "helperDir"] as const;
  const workflowAllowedKeys = [...workflowKeys, "stateProvider"];
  rejectUnknown(workflow, workflowAllowedKeys, "config.workflow");
  const paths = Object.fromEntries(workflowKeys.map((key) => [
    key,
    workflow[key] === undefined && key === "diagnosticsPath"
      ? DEFAULT_PI_NEXT_CONFIG.workflow.diagnosticsPath
      : pathValue(workflow[key], `config.workflow.${key}`),
  ])) as Omit<PiNextConfig["workflow"], "stateProvider">;
  const stateProviderValue = workflow.stateProvider === undefined
    ? DEFAULT_PI_NEXT_CONFIG.workflow.stateProvider
    : object(workflow.stateProvider, "config.workflow.stateProvider");
  rejectUnknown(stateProviderValue, ["type", "path"], "config.workflow.stateProvider");
  if (stateProviderValue.type !== "builtin" && stateProviderValue.type !== "helper") {
    throw new PiNextConfigError("config.workflow.stateProvider.type must be builtin or helper");
  }
  if (stateProviderValue.type === "builtin" && stateProviderValue.path !== undefined) {
    throw new PiNextConfigError("config.workflow.stateProvider.path is only valid for helper providers");
  }
  const stateProvider = stateProviderValue.type === "helper"
    ? { type: "helper" as const, path: pathValue(stateProviderValue.path, "config.workflow.stateProvider.path") }
    : { type: "builtin" as const };

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

  const skills = parseSkillsPolicy(root.skills);

  const reviewValue: Record<string, unknown> = root.adversarialReview === undefined
    ? { ...DEFAULT_PI_NEXT_CONFIG.adversarialReview }
    : object(root.adversarialReview, "config.adversarialReview");
  rejectUnknown(reviewValue, ["enabled", "requiredRisk", "maxRounds", "axes"], "config.adversarialReview");
  if (typeof reviewValue.enabled !== "boolean") throw new PiNextConfigError("config.adversarialReview.enabled must be boolean");
  if (reviewValue.requiredRisk !== "high" && reviewValue.requiredRisk !== "critical") throw new PiNextConfigError("config.adversarialReview.requiredRisk must be high or critical");
  if (typeof reviewValue.maxRounds !== "number" || !Number.isInteger(reviewValue.maxRounds) || reviewValue.maxRounds < 1 || reviewValue.maxRounds > 2) throw new PiNextConfigError("config.adversarialReview.maxRounds must be between 1 and 2");
  const axesValue = strings(reviewValue.axes, "config.adversarialReview.axes", 3) as ReviewAxis[];
  if (axesValue.some((axis) => !["spec", "standards", "risk"].includes(axis))) throw new PiNextConfigError("config.adversarialReview.axes contains an unsupported axis");

  const convergenceValue = root.convergence === undefined
    ? DEFAULT_PI_NEXT_CONFIG.convergence
    : object(root.convergence, "config.convergence");
  rejectUnknown(convergenceValue as Record<string, unknown>, ["softTransitions", "hardTransitions", "softWallMs", "hardWallMs", "softTokens", "hardTokens", "maxPlanTasksWarning"], "config.convergence");
  const convergenceNumber = (key: keyof PiNextConfig["convergence"], fallback: number, min: number, max: number): number => {
    const value = (convergenceValue as Record<string, unknown>)[key] === undefined ? fallback : (convergenceValue as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new PiNextConfigError(`config.convergence.${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  const convergence = {
    softTransitions: convergenceNumber("softTransitions", 6, 1, 100),
    hardTransitions: convergenceNumber("hardTransitions", 12, 2, 200),
    softWallMs: convergenceNumber("softWallMs", 15 * 60_000, 1_000, 86_400_000),
    hardWallMs: convergenceNumber("hardWallMs", 30 * 60_000, 2_000, 172_800_000),
    softTokens: convergenceNumber("softTokens", 2_000_000, 1_000, 100_000_000),
    hardTokens: convergenceNumber("hardTokens", 4_000_000, 2_000, 200_000_000),
    maxPlanTasksWarning: convergenceNumber("maxPlanTasksWarning", 12, 1, 100),
  };
  if (convergence.hardTransitions <= convergence.softTransitions || convergence.hardWallMs <= convergence.softWallMs || convergence.hardTokens <= convergence.softTokens) {
    throw new PiNextConfigError("config.convergence hard budgets must exceed soft budgets");
  }

  const workerWatchdogValue = root.workerWatchdog === undefined
    ? DEFAULT_PI_NEXT_CONFIG.workerWatchdog
    : object(root.workerWatchdog, "config.workerWatchdog");
  rejectUnknown(workerWatchdogValue as Record<string, unknown>, ["default", "roles"], "config.workerWatchdog");
  const parseWatchdog = (raw: unknown, name: string, fallback: WorkerWatchdogPolicy): WorkerWatchdogPolicy => {
    const value: Record<string, unknown> = raw === undefined
      ? fallback as unknown as Record<string, unknown>
      : object(raw, name);
    rejectUnknown(value, ["softIdleMs", "hardIdleMs", "hardWallMs", "terminationGraceMs"], name);
    const numberValue = (key: keyof WorkerWatchdogPolicy, min: number, max: number): number => {
      const candidate = value[key] === undefined ? fallback[key] : value[key];
      if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < min || candidate > max) throw new PiNextConfigError(`${name}.${key} must be an integer between ${min} and ${max}`);
      return candidate;
    };
    const result = {
      softIdleMs: numberValue("softIdleMs", 1_000, 86_400_000),
      hardIdleMs: numberValue("hardIdleMs", 2_000, 172_800_000),
      hardWallMs: numberValue("hardWallMs", 5_000, 604_800_000),
      terminationGraceMs: numberValue("terminationGraceMs", 100, 60_000),
    };
    if (result.hardIdleMs <= result.softIdleMs || result.hardWallMs <= result.softIdleMs) throw new PiNextConfigError(`${name} hard watchdog limits must exceed softIdleMs`);
    return result;
  };
  const watchdogDefault = parseWatchdog((workerWatchdogValue as Record<string, unknown>).default, "config.workerWatchdog.default", DEFAULT_PI_NEXT_CONFIG.workerWatchdog.default);
  const rolesRaw = (workerWatchdogValue as Record<string, unknown>).roles === undefined ? {} : object((workerWatchdogValue as Record<string, unknown>).roles, "config.workerWatchdog.roles");
  const roles: Partial<Record<WorkerRole, WorkerWatchdogPolicy>> = {};
  for (const [role, raw] of Object.entries(rolesRaw)) {
    if (!/^(controller|planning|implementation|repair|review-spec|review-standards|verification|maintenance)$/.test(role)) throw new PiNextConfigError(`config.workerWatchdog.roles.${role} is not a supported worker role`);
    roles[role as WorkerRole] = parseWatchdog(raw, `config.workerWatchdog.roles.${role}`, watchdogDefault);
  }
  const workerWatchdog = { default: watchdogDefault, roles };

  const monitorValue = root.monitor === undefined
    ? DEFAULT_PI_NEXT_CONFIG.monitor as unknown as Record<string, unknown>
    : object(root.monitor, "config.monitor");
  rejectUnknown(monitorValue, ["pollIntervalMs", "maxBackoffMs"], "config.monitor");
  const monitorNumber = (key: keyof PiNextConfig["monitor"], fallback: number, min: number, max: number): number => {
    const value = monitorValue[key] === undefined ? fallback : monitorValue[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new PiNextConfigError(`config.monitor.${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  const monitor = {
    pollIntervalMs: monitorNumber("pollIntervalMs", DEFAULT_PI_NEXT_CONFIG.monitor.pollIntervalMs, 1_000, 86_400_000),
    maxBackoffMs: monitorNumber("maxBackoffMs", DEFAULT_PI_NEXT_CONFIG.monitor.maxBackoffMs, 1_000, 86_400_000),
  };
  if (monitor.maxBackoffMs < monitor.pollIntervalMs) throw new PiNextConfigError("config.monitor.maxBackoffMs must be at least pollIntervalMs");

  const assessmentValue: Record<string, unknown> = root.assessment === undefined
    ? DEFAULT_PI_NEXT_CONFIG.assessment as unknown as Record<string, unknown>
    : object(root.assessment, "config.assessment");
  rejectUnknown(assessmentValue, ["enabled", "noProgressThreshold", "repeatedFailureThreshold", "repeatedCommandThreshold", "contextPressureThreshold", "findingRecurrenceThreshold", "findingMinConfidence", "findingLabels", "heldStates", "approvedStates", "rejectedStates", "supersededStates"], "config.assessment");
  const assessmentNumber = (key: string, fallback: number, min: number, max: number): number => {
    const value = assessmentValue[key] === undefined ? fallback : assessmentValue[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new PiNextConfigError(`config.assessment.${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  const contextPressureThreshold = assessmentValue.contextPressureThreshold === undefined ? DEFAULT_PI_NEXT_CONFIG.assessment.contextPressureThreshold : assessmentValue.contextPressureThreshold;
  if (typeof contextPressureThreshold !== "number" || contextPressureThreshold < 0 || contextPressureThreshold > 1) throw new PiNextConfigError("config.assessment.contextPressureThreshold must be between 0 and 1");
  const findingMinConfidence = assessmentValue.findingMinConfidence === undefined ? DEFAULT_PI_NEXT_CONFIG.assessment.findingMinConfidence : assessmentValue.findingMinConfidence;
  if (!["low", "medium", "high"].includes(String(findingMinConfidence))) throw new PiNextConfigError("config.assessment.findingMinConfidence is unsupported");
  const enabled = assessmentValue.enabled === undefined ? true : assessmentValue.enabled;
  if (typeof enabled !== "boolean") throw new PiNextConfigError("config.assessment.enabled must be boolean");
  const assessment = {
    enabled,
    noProgressThreshold: assessmentNumber("noProgressThreshold", 2, 1, 20),
    repeatedFailureThreshold: assessmentNumber("repeatedFailureThreshold", 2, 1, 20),
    repeatedCommandThreshold: assessmentNumber("repeatedCommandThreshold", 2, 1, 20),
    contextPressureThreshold,
    findingRecurrenceThreshold: assessmentNumber("findingRecurrenceThreshold", 3, 1, 100),
    findingMinConfidence: findingMinConfidence as "low" | "medium" | "high",
    findingLabels: assessmentValue.findingLabels === undefined ? ["agent:finding"] : strings(assessmentValue.findingLabels, "config.assessment.findingLabels", 8),
    heldStates: assessmentValue.heldStates === undefined ? ["pending_review", "needs-review"] : strings(assessmentValue.heldStates, "config.assessment.heldStates", 8),
    approvedStates: assessmentValue.approvedStates === undefined ? ["approved", "ready"] : strings(assessmentValue.approvedStates, "config.assessment.approvedStates", 8),
    rejectedStates: assessmentValue.rejectedStates === undefined ? ["rejected"] : strings(assessmentValue.rejectedStates, "config.assessment.rejectedStates", 8),
    supersededStates: assessmentValue.supersededStates === undefined ? ["superseded", "duplicate"] : strings(assessmentValue.supersededStates, "config.assessment.supersededStates", 8),
  };
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
    workflow: { ...paths, stateProvider },
    workerDispatch: { version: 1, models, maxEscalations: Number(maxEscalations) },
    skills,
    adversarialReview: { enabled: reviewValue.enabled, requiredRisk: reviewValue.requiredRisk, maxRounds: reviewValue.maxRounds, axes: axesValue },
    convergence,
    workerWatchdog,
    monitor,
    assessment,
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

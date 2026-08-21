import { access, constants, existsSync, readFileSync, stat } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadPiNextConfig, configuredPath, type PiNextConfig } from "../../src/coordination/config.ts";
import { acceptanceCriteria, currentTask, section } from "./plan-read.ts";
import { planFile } from "./util-core.ts";

const execFileAsync = promisify(execFile);
const accessAsync = promisify(access);
const statAsync = promisify(stat);
const STATE_PROVIDER_TIMEOUT_MS = 5_000;
const STATE_PROVIDER_MAX_OUTPUT = 64 * 1024;

export type WorkflowState = Record<string, string>;

export class WorkflowStateProviderError extends Error {
  readonly code = "workflow_state_provider_failed";
  constructor(message: string, readonly provider: "builtin" | "helper") {
    super(message);
    this.name = "WorkflowStateProviderError";
  }
}

function countTasks(plan: string): { total: number; unchecked: number } {
  const lines = section(plan, "## Tasks")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*- \[([ xX])\] /))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  return {
    total: lines.length,
    unchecked: lines.filter((match) => match[1].toLowerCase() === " ").length,
  };
}

function goal(plan: string): string {
  return plan.match(/^\*\*Goal:\*\*\s*(.*)$/m)?.[1]?.trim() || "";
}

export function builtInWorkflowState(cwd: string): WorkflowState {
  const file = planFile(cwd);
  if (!existsSync(file)) {
    return {
      PLAN: "absent",
      UNCHECKED_TASKS: "0",
      UNCHECKED_ACCEPTANCE: "0",
      TASKS: "0",
      ACCEPTANCE: "0",
    };
  }
  const plan = readFileSync(file, "utf8");
  const tasks = countTasks(plan);
  const acceptance = acceptanceCriteria(plan);
  const current = currentTask(plan);
  return {
    PLAN: "present",
    TASKS: String(tasks.total),
    UNCHECKED_TASKS: String(tasks.unchecked),
    ACCEPTANCE: String(acceptance.length),
    UNCHECKED_ACCEPTANCE: String(acceptance.filter((criterion) => !criterion.checked).length),
    PLAN_GOAL: goal(plan),
    CURRENT_TASK: current?.task || "",
  };
}

function parseHelperState(output: string): WorkflowState {
  const state: WorkflowState = {};
  for (const line of output.split(/\r?\n/).filter(Boolean).slice(0, 100)) {
    const index = line.indexOf("=");
    if (index <= 0) throw new WorkflowStateProviderError("helper output contains a malformed state line", "helper");
    const key = line.slice(0, index).trim();
    const allowed = new Set([
      "PLAN",
      "TASKS",
      "UNCHECKED",
      "UNCHECKED_TASKS",
      "ACCEPTANCE",
      "UNCHECKED_ACCEPTANCE",
      "PLAN_GOAL",
      "CURRENT_TASK",
    ]);
    if (!allowed.has(key)) {
      throw new WorkflowStateProviderError("helper output contains an unsupported state key", "helper");
    }
    state[key] = line.slice(index + 1).trim().slice(0, 2_000);
  }
  if (!state.PLAN || !/^(?:present|absent)$/.test(state.PLAN)) {
    throw new WorkflowStateProviderError("helper output must include PLAN=present or PLAN=absent", "helper");
  }
  for (const key of ["UNCHECKED_TASKS", "UNCHECKED_ACCEPTANCE"]) {
    if (!state[key] || !/^\d+$/.test(state[key])) {
      throw new WorkflowStateProviderError(`helper output must include a non-negative ${key}`, "helper");
    }
  }
  return state;
}

async function validateHelper(path: string): Promise<void> {
  if (!existsSync(path)) throw new WorkflowStateProviderError(`configured workflow state provider is missing: ${path}`, "helper");
  const details = await statAsync(path).catch(() => undefined);
  if (!details?.isFile()) throw new WorkflowStateProviderError(`configured workflow state provider is not a file: ${path}`, "helper");
  await accessAsync(path, constants.X_OK).catch(() => {
    throw new WorkflowStateProviderError(`configured workflow state provider is not executable: ${path}`, "helper");
  });
}

export function selectedWorkflowStateProvider(config: PiNextConfig): "builtin" | "helper" {
  return config.workflow.stateProvider.type;
}

export function formatWorkflowState(state: WorkflowState): string {
  return Object.entries(state)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function workflowState(
  cwd: string,
  args = "",
  signal?: AbortSignal,
): Promise<{ provider: "builtin" | "helper"; state: WorkflowState; stderr?: string }> {
  const config = loadPiNextConfig(cwd);
  const provider = selectedWorkflowStateProvider(config);
  if (provider === "builtin") return { provider, state: builtInWorkflowState(cwd) };

  const stateProvider = config.workflow.stateProvider;
  if (stateProvider.type !== "helper" || !stateProvider.path) throw new WorkflowStateProviderError("invalid workflow state provider configuration", "helper");
  const path = configuredPath(cwd, stateProvider.path);
  await validateHelper(path);
  try {
    const result = await execFileAsync(path, [cwd, args], {
      cwd,
      signal,
      timeout: STATE_PROVIDER_TIMEOUT_MS,
      maxBuffer: STATE_PROVIDER_MAX_OUTPUT,
      encoding: "utf8",
    });
    return {
      provider,
      state: parseHelperState(result.stdout.trim()),
      stderr: result.stderr.trim().slice(0, 4_000) || undefined,
    };
  } catch (error) {
    if (error instanceof WorkflowStateProviderError) throw error;
    throw new WorkflowStateProviderError(
      `configured workflow state provider failed: ${error instanceof Error ? error.message : String(error)}`,
      "helper",
    );
  }
}

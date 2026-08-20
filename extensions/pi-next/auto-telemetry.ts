import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { sessionUsage, usageDelta, type LoopUsage } from "./loop-state.ts";
import {
  planFile,
  readQualityEvidence,
  runtimeDir,
  writeJsonAtomic,
} from "./util.ts";

const MAX_TRANSITIONS = 100;

export interface AutoQualityCommand {
  command: string;
  durationMs: number;
  completedAt: string;
  reused: boolean;
}

export interface AutoSessionActivity {
  modelRounds: number;
  toolCalls: number;
  toolResults: number;
}

export interface AutoTransition {
  id: string;
  startedAt: string;
  completedAt: string;
  /** Whole managed-transition wall time. This is not model-only time. */
  transitionDurationMs: number;
  /** Legacy v1 field accepted when reading old runtime evidence. */
  durationMs?: number;
  issueNumber?: number;
  transitionType:
    | "plan"
    | "archive"
    | "defer"
    | "advance"
    | "no_progress"
    | "failed";
  model?: string;
  headBefore: string;
  headAfter: string;
  interTransitionHeadDiverged?: boolean;
  sessionActivity?: AutoSessionActivity;
  usage: LoopUsage;
  quality?: {
    level: "quick" | "standard" | "full";
    ok: boolean;
    fingerprint: string;
    completedAt: string;
    logPath: string;
    commands: AutoQualityCommand[];
  };
  error?: string;
}

interface AutoTelemetryTotals extends LoopUsage {
  transitions: number;
  transitionDurationMs: number;
  modelRounds: number;
  toolCalls: number;
  toolResults: number;
  /** Legacy v1 field accepted when reading old runtime evidence. */
  modelDurationMs?: number;
}

export interface AutoTelemetryState {
  version: 2;
  updatedAt: string;
  totals: AutoTelemetryTotals;
  transitions: AutoTransition[];
}

export function autoTelemetryFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-transitions.json");
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function transitionDuration(transition: Partial<AutoTransition>): number {
  return finite(transition.transitionDurationMs ?? transition.durationMs);
}

function emptyTotals(): AutoTelemetryTotals {
  return {
    transitions: 0,
    transitionDurationMs: 0,
    modelRounds: 0,
    toolCalls: 0,
    toolResults: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function normalizeTotals(value: Partial<AutoTelemetryTotals> | undefined): AutoTelemetryTotals {
  if (!value) return emptyTotals();
  return {
    transitions: finite(value.transitions),
    transitionDurationMs: finite(
      value.transitionDurationMs ?? value.modelDurationMs,
    ),
    modelRounds: finite(value.modelRounds),
    toolCalls: finite(value.toolCalls),
    toolResults: finite(value.toolResults),
    input: finite(value.input),
    output: finite(value.output),
    cacheRead: finite(value.cacheRead),
    cacheWrite: finite(value.cacheWrite),
    totalTokens: finite(value.totalTokens),
    cost: finite(value.cost),
  };
}

function normalizeTransition(value: AutoTransition): AutoTransition {
  return {
    ...value,
    transitionDurationMs: transitionDuration(value),
  };
}

function readState(cwd: string): AutoTelemetryState {
  const path = autoTelemetryFile(cwd);
  if (!existsSync(path)) {
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      totals: emptyTotals(),
      transitions: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      updatedAt?: string;
      totals?: Partial<AutoTelemetryTotals>;
      transitions?: AutoTransition[];
    };
    return {
      version: 2,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      totals: normalizeTotals(parsed.totals),
      transitions: Array.isArray(parsed.transitions)
        ? parsed.transitions.slice(-MAX_TRANSITIONS).map(normalizeTransition)
        : [],
    };
  } catch {
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      totals: emptyTotals(),
      transitions: [],
    };
  }
}

export function currentPlanIssue(cwd: string): number | undefined {
  const file = planFile(cwd);
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8").match(/\*\*GitHub-Issue:\*\*\s*#(\d+)/i);
  if (!match) return undefined;
  const issue = Number.parseInt(match[1], 10);
  return Number.isInteger(issue) && issue > 0 ? issue : undefined;
}

export function sessionModel(ctx: ExtensionCommandContext): string | undefined {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    if (typeof message.model === "string" && message.model) return message.model;
    const model = message.model;
    if (model && typeof model === "object") {
      const value = model as Record<string, unknown>;
      if (typeof value.id === "string" && value.id) return value.id;
      if (typeof value.name === "string" && value.name) return value.name;
    }
  }
  return undefined;
}

export function sessionActivity(
  ctx: ExtensionCommandContext,
  startEntryIndex = 0,
): AutoSessionActivity {
  const activity: AutoSessionActivity = {
    modelRounds: 0,
    toolCalls: 0,
    toolResults: 0,
  };
  const entries = ctx.sessionManager.getEntries().slice(Math.max(0, startEntryIndex));
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "toolResult") {
      activity.toolResults += 1;
      continue;
    }
    if (message.role !== "assistant") continue;
    activity.modelRounds += 1;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    activity.toolCalls += content.filter((block) => {
      return Boolean(
        block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "toolCall",
      );
    }).length;
  }
  return activity;
}

export function recordAutoTransition(
  cwd: string,
  transition: AutoTransition,
): void {
  const state = readState(cwd);
  const previous = state.transitions.at(-1);
  const enriched: AutoTransition = {
    ...transition,
    transitionDurationMs: transitionDuration(transition),
    interTransitionHeadDiverged:
      transition.interTransitionHeadDiverged ??
      Boolean(previous?.headAfter && previous.headAfter !== transition.headBefore),
  };
  const usage = enriched.usage;
  const activity = enriched.sessionActivity;
  const next: AutoTelemetryState = {
    version: 2,
    updatedAt: enriched.completedAt,
    totals: {
      transitions: state.totals.transitions + 1,
      transitionDurationMs:
        state.totals.transitionDurationMs + enriched.transitionDurationMs,
      modelRounds: state.totals.modelRounds + finite(activity?.modelRounds),
      toolCalls: state.totals.toolCalls + finite(activity?.toolCalls),
      toolResults: state.totals.toolResults + finite(activity?.toolResults),
      input: state.totals.input + usage.input,
      output: state.totals.output + usage.output,
      cacheRead: state.totals.cacheRead + usage.cacheRead,
      cacheWrite: state.totals.cacheWrite + usage.cacheWrite,
      totalTokens: state.totals.totalTokens + usage.totalTokens,
      cost: state.totals.cost + usage.cost,
    },
    transitions: [...state.transitions, enriched].slice(-MAX_TRANSITIONS),
  };
  writeJsonAtomic(autoTelemetryFile(cwd), next);
}

export function transitionUsage(
  ctx: ExtensionCommandContext,
  before: ReturnType<typeof sessionUsage>,
): LoopUsage {
  return usageDelta(sessionUsage(ctx), before);
}

export function qualitySnapshot(cwd: string): AutoTransition["quality"] | undefined {
  const evidence = readQualityEvidence(cwd);
  if (!evidence) return undefined;
  return {
    level: evidence.level,
    ok: evidence.ok,
    fingerprint: evidence.fingerprint,
    completedAt: evidence.completedAt,
    logPath: evidence.logPath,
    commands: (evidence.commands || []).map((command) => ({
      command: command.command,
      durationMs: command.durationMs,
      completedAt: command.completedAt,
      reused: Boolean(command.reused),
    })),
  };
}

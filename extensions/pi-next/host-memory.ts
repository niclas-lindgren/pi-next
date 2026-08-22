import { existsSync, readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

import { runtimeDir, writeJsonAtomic } from "./util.ts";

const MEMORY_FILE = "pi-next-memory.json";
const MAX_SAMPLES = 128;
const DEFAULT_HIGH_RATIO = 0.78;
const DEFAULT_CRITICAL_RATIO = 0.9;
const DEFAULT_CRITICAL_STREAK = 2;

export type HostMemoryPressure = "normal" | "high" | "critical";

export interface HostMemoryBoundaryContext {
  boundary: string;
  runId?: string;
  issueNumber?: number;
  step?: number;
  workerBatchTransition?: number;
  /** @deprecated Read-only compatibility for historical samples. */
  sessionTransition?: number;
}

export interface HostMemoryUsage {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers?: number;
}

export interface HostMemorySample extends HostMemoryBoundaryContext {
  at: string;
  heapLimit: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers?: number;
  heapUsedDelta: number;
  rssDelta: number;
  fromBaselineHeapUsed: number;
  fromBaselineRss: number;
  pressure: HostMemoryPressure;
}

export interface HostMemoryHealth {
  version: 1;
  runId?: string;
  baselineHeapUsed: number;
  baselineRss: number;
  lastStableHeapUsed: number;
  lastStableRss: number;
  criticalStreak: number;
  pressure: HostMemoryPressure;
  restartRequired: boolean;
  samples: HostMemorySample[];
}

export interface HostMemoryPolicy {
  highHeapRatio?: number;
  criticalHeapRatio?: number;
  criticalStreak?: number;
}

export interface HostMemoryObservationOptions {
  /** Start a new process baseline while retaining the bounded sample history. */
  resetBaseline?: boolean;
}

interface HostMemoryFile {
  version: 1;
  health: HostMemoryHealth;
  samples: HostMemorySample[];
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function envRatio(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function policyValues(policy: HostMemoryPolicy = {}): Required<HostMemoryPolicy> {
  return {
    highHeapRatio: policy.highHeapRatio ?? envRatio("PI_NEXT_HOST_MEMORY_HIGH_RATIO", DEFAULT_HIGH_RATIO),
    criticalHeapRatio: policy.criticalHeapRatio ?? envRatio("PI_NEXT_HOST_MEMORY_CRITICAL_RATIO", DEFAULT_CRITICAL_RATIO),
    criticalStreak: Math.max(1, Math.floor(policy.criticalStreak ?? (Number.parseInt(process.env.PI_NEXT_HOST_MEMORY_CRITICAL_STREAK || "", 10) || DEFAULT_CRITICAL_STREAK))),
  };
}

export function classifyHostMemoryPressure(
  heapUsed: number,
  heapLimit: number,
  policy: HostMemoryPolicy = {},
): HostMemoryPressure {
  const ratio = heapLimit > 0 ? heapUsed / heapLimit : 0;
  const values = policyValues(policy);
  if (ratio >= values.criticalHeapRatio) return "critical";
  if (ratio >= values.highHeapRatio) return "high";
  return "normal";
}

export function hostMemoryNeedsRestart(
  pressure: HostMemoryPressure,
  criticalStreak: number,
  policy: HostMemoryPolicy = {},
): boolean {
  return pressure === "critical" && criticalStreak >= policyValues(policy).criticalStreak;
}

export function hostMemoryFile(cwd: string): string {
  return `${runtimeDir(cwd)}/${MEMORY_FILE}`;
}

function readFile(cwd: string): HostMemoryFile | undefined {
  try {
    const value = JSON.parse(readFileSync(hostMemoryFile(cwd), "utf8")) as Partial<HostMemoryFile>;
    if (value.version !== 1 || !value.health || !Array.isArray(value.samples)) return undefined;
    return {
      version: 1,
      health: value.health as HostMemoryHealth,
      samples: value.samples.slice(-MAX_SAMPLES),
    };
  } catch {
    return undefined;
  }
}

export function observeHostMemory(
  cwd: string,
  context: HostMemoryBoundaryContext,
  usage: HostMemoryUsage = process.memoryUsage(),
  heapLimit = finite(getHeapStatistics().heap_size_limit),
  policy: HostMemoryPolicy = {},
  options: HostMemoryObservationOptions = {},
): { sample: HostMemorySample; health: HostMemoryHealth } {
  const previous = readFile(cwd);
  const sameRun = previous?.health.runId === context.runId && !options.resetBaseline;
  const oldSample = sameRun ? previous?.samples.at(-1) : undefined;
  const baselineHeapUsed = sameRun ? previous!.health.baselineHeapUsed : finite(usage.heapUsed);
  const baselineRss = sameRun ? previous!.health.baselineRss : finite(usage.rss);
  const heapUsed = finite(usage.heapUsed);
  const rss = finite(usage.rss);
  const pressure = classifyHostMemoryPressure(heapUsed, heapLimit, policy);
  const criticalStreak = pressure === "critical"
    ? (sameRun ? previous!.health.criticalStreak : 0) + 1
    : 0;
  const sample: HostMemorySample = {
    ...context,
    at: new Date().toISOString(),
    heapLimit,
    heapUsed,
    heapTotal: finite(usage.heapTotal),
    rss,
    external: finite(usage.external),
    ...(usage.arrayBuffers === undefined ? {} : { arrayBuffers: finite(usage.arrayBuffers) }),
    heapUsedDelta: oldSample ? heapUsed - oldSample.heapUsed : 0,
    rssDelta: oldSample ? rss - oldSample.rss : 0,
    fromBaselineHeapUsed: heapUsed - baselineHeapUsed,
    fromBaselineRss: rss - baselineRss,
    pressure,
  };
  const samples = [...(previous?.samples || []), sample].slice(-MAX_SAMPLES);
  const health: HostMemoryHealth = {
    version: 1,
    ...(context.runId ? { runId: context.runId } : {}),
    baselineHeapUsed,
    baselineRss,
    lastStableHeapUsed: pressure === "normal" ? heapUsed : (previous?.health.lastStableHeapUsed ?? heapUsed),
    lastStableRss: pressure === "normal" ? rss : (previous?.health.lastStableRss ?? rss),
    criticalStreak,
    pressure,
    restartRequired: hostMemoryNeedsRestart(pressure, criticalStreak, policy),
    samples,
  };
  writeJsonAtomic(hostMemoryFile(cwd), { version: 1, health, samples } satisfies HostMemoryFile);
  return { sample, health };
}

export function memoryPressureReason(health: HostMemoryHealth): string {
  const latest = health.samples.at(-1);
  const ratio = latest && latest.heapLimit > 0 ? Math.round((latest.heapUsed / latest.heapLimit) * 100) : 0;
  return `host_memory_pressure: restart_required (heap ${ratio}% of limit; critical streak ${health.criticalStreak})`;
}

export const HOST_MEMORY_SAMPLE_LIMIT = MAX_SAMPLES;

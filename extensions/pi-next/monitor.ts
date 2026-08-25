import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadPiNextConfig, type PiNextConfig } from "../../src/coordination/config.ts";
import { createWorkAuthority, type WorkAuthorityAdapter } from "../../src/coordination/work-authority.ts";
import { candidateShortlist } from "./issue-candidates.ts";
import { GitHubIssueLeaseAuthority, type IssueLeaseAuthority } from "./issue-leases.ts";
import { MAX_ISSUES } from "./loop-state.ts";
import { sessionIdentity } from "./live-ctx.ts";
import { safeNotify } from "./util.ts";

export type MonitorPhase = "stopped" | "monitoring" | "working" | "backoff" | "stopping";

export interface MonitorStatus {
  running: boolean;
  phase: MonitorPhase;
  generation: string;
  cwd: string;
  lastSuccessfulCheckAt?: string;
  lastEligibleCount?: number;
  lastSelection?: string;
  nextCheckAt?: string;
  activeRun?: string;
  lastError?: { type: string; message: string };
  wakeUps: number;
  schedulerLaunches: number;
  authorityChecks: number;
}

export interface MonitorDeps {
  cwd: string;
  config?: PiNextConfig;
  authority?: WorkAuthorityAdapter;
  leaseAuthority?: IssueLeaseAuthority;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  scheduler?: () => Promise<void>;
  onStatus?: (status: MonitorStatus) => void;
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;
const MIN_POLL_INTERVAL_MS = 1_000;

function iso(now: () => Date): string {
  return now().toISOString();
}

function boundedDelay(value: number, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export class PiNextMonitor {
  private readonly config: PiNextConfig;
  private readonly authority: WorkAuthorityAdapter;
  private readonly leaseAuthority?: IssueLeaseAuthority;
  private readonly scheduler: () => Promise<void>;
  private readonly onStatus?: (status: MonitorStatus) => void;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown;
  private checkInFlight = false;
  private running = false;
  private stopRequested = false;
  private backoffMs = 0;
  private status: MonitorStatus;

  readonly pollIntervalMs: number;
  readonly maxBackoffMs: number;

  constructor(deps: MonitorDeps) {
    this.config = deps.config ?? loadPiNextConfig(deps.cwd);
    this.authority = deps.authority ?? createWorkAuthority(deps.cwd, this.config);
    this.leaseAuthority = deps.leaseAuthority;
    this.pollIntervalMs = boundedDelay(deps.pollIntervalMs ?? this.config.monitor.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, 86_400_000);
    this.maxBackoffMs = boundedDelay(deps.maxBackoffMs ?? this.config.monitor.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, this.pollIntervalMs, 86_400_000);
    this.scheduler = deps.scheduler ?? (async () => undefined);
    this.onStatus = deps.onStatus;
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.status = {
      running: false,
      phase: "stopped",
      generation: `${Date.now()}-${process.pid}`,
      cwd: deps.cwd,
      wakeUps: 0,
      schedulerLaunches: 0,
      authorityChecks: 0,
    };
  }

  start(): MonitorStatus {
    if (this.running) return this.snapshot();
    this.running = true;
    this.stopRequested = false;
    this.backoffMs = 0;
    this.status = { ...this.status, running: true, phase: "monitoring", nextCheckAt: iso(this.now), lastError: undefined };
    this.emit();
    this.schedule(0);
    return this.snapshot();
  }

  stop(): MonitorStatus {
    this.stopRequested = true;
    this.running = false;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.status = { ...this.status, running: false, phase: this.checkInFlight ? "stopping" : "stopped", nextCheckAt: undefined };
    this.emit();
    return this.snapshot();
  }

  snapshot(): MonitorStatus {
    return structuredClone(this.status);
  }

  async checkNow(): Promise<MonitorStatus> {
    if (!this.running || this.checkInFlight) return this.snapshot();
    this.checkInFlight = true;
    try {
      this.status = { ...this.status, phase: "monitoring", authorityChecks: this.status.authorityChecks + 1 };
      this.emit();
      const shortlist = await candidateShortlist(this.status.cwd, {
        authority: this.authority,
        config: this.config,
        leaseAuthority: this.leaseAuthority,
        refreshMain: false,
      });
      if (shortlist.outcome === "unavailable") throw new Error(shortlist.reason || "candidate discovery unavailable");
      this.backoffMs = 0;
      const candidate = shortlist.candidateIssueNumber;
      this.status = {
        ...this.status,
        phase: "monitoring",
        lastSuccessfulCheckAt: iso(this.now),
        lastEligibleCount: candidate ? 1 : 0,
        lastSelection: shortlist.outcome,
        lastError: undefined,
      };
      this.emit();
      if (candidate && !this.stopRequested) {
        this.status = {
          ...this.status,
          phase: "working",
          activeRun: `monitor-wake-${this.status.wakeUps + 1}`,
          wakeUps: this.status.wakeUps + 1,
          schedulerLaunches: this.status.schedulerLaunches + 1,
        };
        this.emit();
        await this.scheduler();
        this.status = { ...this.status, phase: "monitoring", activeRun: undefined };
      }
      if (this.running && !this.stopRequested) this.schedule(this.pollIntervalMs);
      else this.status = { ...this.status, phase: "stopped", running: false, nextCheckAt: undefined };
    } catch (error) {
      const next = this.backoffMs ? Math.min(this.maxBackoffMs, this.backoffMs * 2) : Math.min(this.maxBackoffMs, Math.max(this.pollIntervalMs, MIN_POLL_INTERVAL_MS));
      this.backoffMs = next;
      this.status = {
        ...this.status,
        phase: this.running ? "backoff" : "stopped",
        lastError: { type: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
      };
      if (this.running && !this.stopRequested) this.schedule(next);
    } finally {
      this.checkInFlight = false;
      if (!this.running && this.status.phase === "stopping") this.status = { ...this.status, phase: "stopped" };
      this.emit();
    }
    return this.snapshot();
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    const at = new Date(this.now().getTime() + delayMs).toISOString();
    this.status = { ...this.status, nextCheckAt: at };
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.checkNow();
    }, delayMs);
    this.emit();
  }

  private emit(): void {
    this.onStatus?.(this.snapshot());
  }
}

const monitors = new Map<string, PiNextMonitor>();

export function monitorKey(cwd: string, _sessionId: string | undefined): string {
  return cwd;
}

export function getMonitor(cwd: string, sessionId: string | undefined): PiNextMonitor | undefined {
  return monitors.get(monitorKey(cwd, sessionId));
}

export function startMonitor(ctx: ExtensionCommandContext, onStatus?: (status: MonitorStatus) => void): MonitorStatus {
  const key = monitorKey(ctx.cwd, sessionIdentity(ctx));
  const existing = monitors.get(key);
  if (existing?.snapshot().running) return existing.snapshot();
  const config = loadPiNextConfig(ctx.cwd);
  const monitor = new PiNextMonitor({
    cwd: ctx.cwd,
    config,
    authority: createWorkAuthority(ctx.cwd, config),
    leaseAuthority: new GitHubIssueLeaseAuthority(ctx.cwd),
    scheduler: async () => {
      const { runProductionLifecycleScheduler } = await import("./production-lifecycle.ts");
      await runProductionLifecycleScheduler({ cwd: ctx.cwd, ctx, entry: "monitor", requestedIssues: MAX_ISSUES });
    },
    onStatus,
  });
  monitors.set(key, monitor);
  return monitor.start();
}

export function stopMonitor(ctx: ExtensionCommandContext): MonitorStatus | undefined {
  const monitor = getMonitor(ctx.cwd, sessionIdentity(ctx));
  return monitor?.stop();
}

export function formatMonitorStatus(status: MonitorStatus | undefined): string {
  if (!status) return "Monitor: stopped";
  const lines = [
    `Monitor: ${status.phase}${status.running ? " (running)" : ""}`,
    `Checks: ${status.authorityChecks} · last=${status.lastSuccessfulCheckAt || "never"} · next=${status.nextCheckAt || "none"}`,
    `Selection: ${status.lastSelection || "none"} · eligible=${status.lastEligibleCount ?? "unknown"}`,
    `Wake-ups: ${status.wakeUps} · scheduler launches=${status.schedulerLaunches}${status.activeRun ? ` · active=${status.activeRun}` : ""}`,
  ];
  if (status.lastError) lines.push(`Last error: ${status.lastError.type}: ${status.lastError.message}`);
  return lines.join("\n");
}

export function notifyMonitorStatus(ctx: ExtensionCommandContext, status: MonitorStatus | undefined): void {
  safeNotify(ctx, formatMonitorStatus(status), "info");
}

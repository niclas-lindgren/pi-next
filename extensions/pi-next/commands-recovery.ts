import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  GitHubIssueLeaseAuthority,
  issueWorkspaceIdentity,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import {
  isIssueLeaseFresh,
  issueLeaseMatchesOwner,
} from "./issue-authority.ts";
import { registerPiNextCommands as registerBasePiNextCommands } from "./commands.ts";
import {
  currentSupervisorStatus,
  formatSupervisorStatus,
  ForegroundSupervisor,
} from "./foreground-supervisor.ts";
import {
  listLoopStates,
  loopResultFile,
  loopStateFile,
  type LoopState,
} from "./loop-state.ts";
import {
  changeFiles,
  markerFile,
  runtimeDir,
  safeNotify,
  writeJsonAtomic,
} from "./util.ts";

const AUTO_STATUS_KEY = "pi-next-auto";
const AUTO_STATUS_INTERVAL_MS = 2_500;

// Session replacement tears down the ExtensionContext that owns a command.
// Keep only cancellation callbacks here so shutdown never has to touch the
// old context. The heartbeat's returned stop function clears the UI only
// while its original session is still active.
const autoStatusHeartbeatCancellations = new Set<() => void>();

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controllerLockFile(cwd: string, runId: string): string {
  return join(runtimeDir(cwd), "pi-next-loops", runId, "controller.lock");
}

function controllerPid(cwd: string, runId: string): number | undefined {
  const path = controllerLockFile(cwd, runId);
  if (!existsSync(path)) return undefined;
  try {
    const lock = readFileSync(path, "utf8");
    const lockRunId = lock.match(/^run_id=(.+)$/m)?.[1]?.trim();
    if (lockRunId && lockRunId !== runId) return undefined;
    const pid = Number.parseInt(lock.match(/^pid=(\d+)$/m)?.[1] || "0", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function locallyAbandoned(cwd: string, state: LoopState): boolean {
  const pid = controllerPid(cwd, state.runId);
  if (pid === undefined) {
    // A previous safe recovery attempt may already have converted the owner to
    // interrupted/stopped and removed its stale lock. A lockless `running`
    // state is still ambiguous with the claim -> controller-lock handoff and
    // must not be reclaimed automatically.
    return ["interrupted", "stopped"].includes(state.status);
  }
  return !processAlive(pid);
}

/**
 * Return the run controlled by this interactive Pi process. This is diagnostic
 * only; lease authority remains GitHub. A preferred recovery run may be shown
 * before its fresh controller lock is installed.
 */
function activeAutoStatusRun(cwd: string, preferredRunId?: string): LoopState | undefined {
  if (preferredRunId) {
    const preferred = listLoopStates(cwd).find((state) => state.runId === preferredRunId);
    if (preferred && ["running", "interrupted", "stopped"].includes(preferred.status)) {
      return preferred;
    }
  }

  return listLoopStates(cwd).find((state) => {
    if (state.status !== "running") return false;
    const pid = controllerPid(cwd, state.runId);
    return pid === process.pid;
  });
}

/**
 * Delegates step/elapsed/liveness formatting to
 * foreground-supervisor.ts's shared `currentSupervisorStatus`/
 * `formatSupervisorStatus` (#612) instead of duplicating that
 * computation here; this function only resolves *which* local run this
 * process's heartbeat should describe (still `activeAutoStatusRun`'s
 * pid-scoped, diagnostic-only selection) and the pre-first-step fallback
 * text.
 */
function autoStatusText(cwd: string, startedAt: number, preferredRunId?: string): string {
  const state = activeAutoStatusRun(cwd, preferredRunId);
  const elapsedFallback = `pi-next auto · starting · ${Math.max(0, Math.round((Date.now() - startedAt) / 1_000))}s`;
  if (!state) return elapsedFallback;
  const status = currentSupervisorStatus(cwd, state.runId);
  return status ? `pi-next ${formatSupervisorStatus(status)}` : elapsedFallback;
}

function setAutoStatusSafely(
  ctx: ExtensionCommandContext,
  text: string | undefined,
): void {
  try {
    ctx.ui.setStatus(AUTO_STATUS_KEY, text);
  } catch {
    // Status is diagnostic only; never fail auto execution because the UI was disposed.
  }
}

export function startAutoStatusHeartbeat(
  ctx: ExtensionCommandContext,
  preferredRunId: () => string | undefined,
): () => void {
  // Read cwd before any session replacement. It is plain data and remains
  // valid after the command context becomes stale.
  const cwd = ctx.cwd;
  const startedAt = Date.now();
  let active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    autoStatusHeartbeatCancellations.delete(cancel);
  };
  const stop = () => {
    if (!active) return;
    cancel();
    // `stop` is called by the command's finally block. If session shutdown
    // already canceled the heartbeat, this branch is skipped and the stale
    // context is never accessed.
    setAutoStatusSafely(ctx, undefined);
  };
  autoStatusHeartbeatCancellations.add(cancel);

  const update = () => {
    // session_shutdown cancels the timer before the replacement context is
    // disposed. This guard also handles an already queued timer callback.
    if (!active) return;
    setAutoStatusSafely(ctx, autoStatusText(cwd, startedAt, preferredRunId()));
  };
  const timer = setInterval(update, AUTO_STATUS_INTERVAL_MS);
  timer.unref?.();
  update();
  return stop;
}

/**
 * Recover only the local run that still owns the authoritative fresh issue
 * lease. Multiple historical run records may point at the same issue after
 * restarts; choosing by local status/mtime alone can select an obsolete owner
 * and then fail (or, worse, attempt to compete with) the real lease holder.
 */
export async function recoverableAbandonedAutoRun(
  cwd: string,
  authorityOverride?: Pick<IssueLeaseAuthority, "read">,
): Promise<LoopState | undefined> {
  const authority = authorityOverride ?? new GitHubIssueLeaseAuthority(cwd);
  const candidates = listLoopStates(cwd).filter((state) => {
    const issueNumber = state.activeIssueNumber;
    const lease = state.activeLease;
    const canonicalWorkspace =
      typeof issueNumber === "number" && issueNumber > 0
        ? resolve(cwd, issueWorkspaceIdentity(issueNumber).worktree)
        : undefined;
    return (
      ["running", "interrupted", "stopped"].includes(state.status) &&
      state.remainingIssues > 0 &&
      typeof issueNumber === "number" &&
      Number.isSafeInteger(issueNumber) &&
      issueNumber > 0 &&
      lease !== undefined &&
      lease.issueNumber === issueNumber &&
      lease.agent === "pi-next" &&
      state.activeWorkspace === canonicalWorkspace
    );
  });
  const leases = new Map<number, Awaited<ReturnType<IssueLeaseAuthority["read"]>>>();

  for (const state of candidates) {
    const issueNumber = state.activeIssueNumber as number;
    let liveLease = leases.get(issueNumber);
    if (!leases.has(issueNumber)) {
      liveLease = await authority.read(issueNumber);
      leases.set(issueNumber, liveLease);
    }
    if (!liveLease || !isIssueLeaseFresh(liveLease)) continue;
    if (!issueLeaseMatchesOwner(liveLease, state.activeLease!)) continue;

    // We found the one local state that owns the current GitHub lease. Never
    // fall through to an older run for the same issue if this owner is still
    // live/ambiguous; that older state is definitively obsolete.
    return locallyAbandoned(cwd, state) ? state : undefined;
  }
  return undefined;
}

export interface AbandonedAutoResumePreparation {
  ok: boolean;
  reason?: string;
  markerCleared?: boolean;
  dirtyFiles?: string[];
}

/**
 * Retire the transition that died with the old Pi process before invoking the
 * normal resume path. The authoritative issue worktree is never reset, stashed,
 * or auto-committed here: unfinished edits are preserved for the fresh recovery
 * worker, whose normal dirty-boundary provenance rules decide how to continue.
 * A continuation marker is cleared only when the worktree is otherwise clean;
 * with unfinished edits it is retained as recovery context. Coordination-root
 * markers are deliberately untouched because the issue worker did not run there
 * and they may belong to another harness.
 */
export async function prepareAbandonedAutoResume(
  coordinationCwd: string,
  state: LoopState,
): Promise<AbandonedAutoResumePreparation> {
  if (state.step <= state.settledStep) return { ok: true };
  if (existsSync(loopResultFile(coordinationCwd, state.runId))) return { ok: true };

  const issueNumber = state.activeIssueNumber;
  const canonicalWorkspace =
    typeof issueNumber === "number" && issueNumber > 0
      ? resolve(coordinationCwd, issueWorkspaceIdentity(issueNumber).worktree)
      : undefined;
  if (
    !Number.isSafeInteger(issueNumber) ||
    !state.activeWorkspace ||
    state.activeWorkspace !== canonicalWorkspace
  ) {
    return {
      ok: false,
      reason: "Cannot recover abandoned pi-next run: persisted issue workspace is not canonical",
    };
  }
  const executionCwd = state.activeWorkspace;
  if (!existsSync(executionCwd)) {
    return {
      ok: false,
      reason: `Cannot recover abandoned pi-next run ${state.runId}: active workspace is missing (${executionCwd})`,
    };
  }

  let dirty: string[];
  try {
    dirty = (await changeFiles(executionCwd, "all")).filter(
      (path) => path !== relative(executionCwd, markerFile(executionCwd)).replace(/\\/g, "/"),
    );
  } catch (error) {
    return {
      ok: false,
      reason: `Cannot inspect abandoned pi-next worktree before recovery: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const marker = markerFile(executionCwd);
  const markerCleared = dirty.length === 0 && existsSync(marker);
  if (markerCleared) unlinkSync(marker);

  writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), {
    ...state,
    settledStep: state.step,
    updatedAt: new Date().toISOString(),
    lastReason: dirty.length
      ? `Recovered abandoned transition with uncommitted issue-worktree changes preserved for fresh recovery (${dirty.join(", ")})`
      : markerCleared
        ? "Recovered abandoned transition from clean durable state; cleared its issue-worktree continuation marker"
        : "Recovered abandoned transition from clean durable state",
  });
  return { ok: true, markerCleared, dirtyFiles: dirty };
}

/**
 * Wrap only the public /pi-next command registration. All ordinary command
 * behavior remains in commands.ts; this adds restart recovery for `auto`
 * before that handler would create a competing run with a new lease identity.
 */
export function registerPiNextCommands(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    // Do not clear UI state here: this callback runs as the old session is
    // being torn down. Only stop callbacks that are safe across replacement.
    for (const cancel of [...autoStatusHeartbeatCancellations]) cancel();
  });

  const registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
    if (name !== "pi-next") return pi.registerCommand(name, command);
    return pi.registerCommand(name, {
      ...command,
      handler: async (args, ctx) => {
        const auto = args.trim() === "auto";
        let preferredRunId: string | undefined;
        const stopStatus = auto
          ? startAutoStatusHeartbeat(ctx, () => preferredRunId)
          : undefined;
        try {
          if (auto) {
            try {
              // ForegroundSupervisor.recoverOnStart owns the authority-first
              // decision (fresh lease -> local run) and, when it finds a
              // genuine owner, resumes it itself; only the notifications
              // stay here.
              const outcome = await ForegroundSupervisor.recoverOnStart(ctx);
              if (outcome.runId) preferredRunId = outcome.runId;
              if (outcome.blockedReason) {
                safeNotify(ctx, outcome.blockedReason, "warning");
                return;
              }
              if (outcome.recovered) {
                safeNotify(
                  ctx,
                  `Recovering abandoned pi-next run ${outcome.runId} for #${outcome.issueNumber}`,
                  "info",
                );
                if (outcome.dirtyFiles?.length) {
                  safeNotify(
                    ctx,
                    `Preserving #${outcome.issueNumber} in-progress changes for recovery: ${outcome.dirtyFiles.join(", ")}`,
                    "info",
                  );
                }
                return;
              }
            } catch (error) {
              safeNotify(
                ctx,
                `pi-next recovery lookup failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              return;
            }
          }
          await command.handler(args, ctx);
        } finally {
          stopStatus?.();
        }
      },
    });
  };

  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand") return registerCommand;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  registerBasePiNextCommands(wrapped);
}

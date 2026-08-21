import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  GitHubIssueLeaseAuthority,
  issueWorkspaceIdentity,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import { issueLeaseMatchesOwner } from "./issue-authority.ts";
import { registerPiNextCommands as registerBasePiNextCommands } from "./commands.ts";
import {
  currentSupervisorStatus,
  ForegroundSupervisor,
} from "./foreground-supervisor.ts";
import { getLiveCtx, sessionIdentity, setLiveCtx } from "./live-ctx.ts";
import {
  listLoopStates,
  loopResultFile,
  loopStateFile,
  readLoopState,
  type LoopState,
} from "./loop-state.ts";
import { renderAutoProgress } from "./auto-progress.ts";
import { piNextRuntimeIdentity } from "../../src/version.ts";
import {
  changeFiles,
  markerFile,
  runtimeDir,
  safeNotify,
  writeJsonAtomic,
} from "./util.ts";

const AUTO_STATUS_KEY = "pi-next-auto";
const AUTO_STATUS_INTERVAL_MS = 2_500;

// Heartbeats resolve the live context at write time, so they survive Pi's
// session replacement. Keep cancellation callbacks for explicit command
// completion, but do not cancel an active run merely because its UI context
// was replaced.
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
 * Return the run explicitly owned by this session. Lease authority remains
 * GitHub, but a footer must never use repository-global timestamp ordering as
 * an identity fallback when another worker is active.
 */
export function activeAutoStatusRun(
  cwd: string,
  preferredRunId?: string,
  ownerSessionId?: string,
): LoopState | undefined {
  const states = listLoopStates(cwd).filter((state) =>
    ["running", "completed", "idle", "blocked", "failed", "stopped", "interrupted"].includes(state.status),
  );
  if (preferredRunId) return states.find((state) => state.runId === preferredRunId);
  if (!ownerSessionId) return undefined;
  return states
    .filter((state) => state.sessionId === ownerSessionId)
    .sort((a, b) => {
      const updated = b.updatedAt.localeCompare(a.updatedAt);
      if (updated !== 0) return updated;
      const created = b.createdAt.localeCompare(a.createdAt);
      return created !== 0 ? created : b.runId.localeCompare(a.runId);
    })[0];
}

/**
 * Resolves the durable run and live supervisor snapshot for the footer
 * renderer. The heartbeat is deliberately presentation-only: it never owns
 * or infers workflow authority.
 */
function autoStatusText(
  cwd: string,
  startedAt: number,
  preferredRunId?: string,
  ownerSessionId?: string,
  version?: string,
  replaceExisting = false,
): string {
  const state = replaceExisting
    ? undefined
    : activeAutoStatusRun(cwd, preferredRunId, ownerSessionId);
  const elapsedFallback = `Pi-next ${version ? `v${version} ` : ""}auto · no issue attached · ${Math.max(0, Math.round((Date.now() - startedAt) / 1_000))}s`;
  if (!state) return elapsedFallback;
  const supervisor = currentSupervisorStatus(cwd, state.runId);
  // setStatus is rendered by Pi in its footer/status surface. Keep all queue
  // progress here rather than emitting repeated transcript notifications.
  return renderAutoProgress(
    readLoopState(cwd, state.runId) || state,
    {
      supervisor,
      version,
      width: process.stdout.columns,
    },
  );
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
  options: { replaceExisting?: boolean } = {},
): () => void {
  // Read cwd before any session replacement. It is plain data and remains
  // valid after the command context becomes stale. UI writes resolve the
  // current context at call time; the captured context is only a fallback for
  // direct/test callers that have not installed the registry.
  setLiveCtx(ctx);
  const cwd = ctx.cwd;
  const startedAt = Date.now();
  const version = piNextRuntimeIdentity().version;
  const ownerSessionId = sessionIdentity(ctx);
  let active = true;
  let firstUpdate = true;
  let boundRunId: string | undefined;
  const cancel = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    autoStatusHeartbeatCancellations.delete(cancel);
  };
  const stop = () => {
    if (!active) return;
    // Render once more after the controller has settled. Ordinary command
    // completion is not a request to clear the footer; the durable terminal
    // state is the useful handoff to the operator and to a replacement
    // session. Shutdown cancels first, so this never touches a disposed ctx.
    update();
    cancel();
  };
  autoStatusHeartbeatCancellations.add(cancel);

  const update = () => {
    // session_shutdown cancels the timer before the replacement context is
    // disposed. This guard also handles an already queued timer callback.
    if (!active) return;
    const liveCtx = getLiveCtx();
    if (liveCtx) {
      // Bind once to this session's own durable run. Before that happens,
      // deliberately render a neutral state instead of borrowing the newest
      // run from the repository runtime directory.
      boundRunId ||= preferredRunId() || activeAutoStatusRun(
        cwd,
        undefined,
        ownerSessionId,
      )?.runId;
      setAutoStatusSafely(
        liveCtx,
        autoStatusText(
          cwd,
          startedAt,
          boundRunId,
          ownerSessionId,
          version,
          Boolean(options.replaceExisting && firstUpdate),
        ),
      );
    }
    firstUpdate = false;
  };
  const timer = setInterval(update, AUTO_STATUS_INTERVAL_MS);
  timer.unref?.();
  update();
  return stop;
}

/**
 * Recover only the local run that still matches the authoritative issue lease.
 * Both fresh and expired leases are eligible: the latter must flow through
 * reconcileIssueLeaseForResume()'s compare-and-swap takeover before execution.
 * Multiple historical run records may point at the same issue after restarts;
 * choosing by local status/mtime alone can select an obsolete owner and then
 * fail (or, worse, attempt to compete with) the real lease holder.
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
    if (!liveLease || !issueLeaseMatchesOwner(liveLease, state.activeLease!)) continue;

    // We found the one local state that identifies the current GitHub lease.
    // claimLoopIssue() will preserve a matching fresh lease or CAS-reclaim a
    // matching stale lease before ensureIssueWorktree() or worker execution.
    // Never fall through to an older run for the same issue if this owner is
    // still live/ambiguous; that older state is definitively obsolete.
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
  ownerSessionId?: string,
): Promise<AbandonedAutoResumePreparation> {
  if (ownerSessionId && state.sessionId !== ownerSessionId) {
    // Recovery has already passed the authoritative lease check. Bind the
    // recovered run before any early-return path so reloads cannot later
    // rediscover it as an unowned repository-global status.
    state = { ...state, sessionId: ownerSessionId };
    writeJsonAtomic(loopStateFile(coordinationCwd, state.runId), state);
  }
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
    sessionId: ownerSessionId || state.sessionId,
    // The abandoned boundary has been reconciled locally. Mark it runnable so
    // ForegroundSupervisor.launch() can start the fresh same-issue worker;
    // leaving this as interrupted would make its running-state loop exit before
    // dispatching anything.
    status: "running",
    workerResultMissing: undefined,
    stopRequested: false,
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
export function clearAutoStatus(ctx: ExtensionCommandContext): void {
  setAutoStatusSafely(ctx, undefined);
}

export function registerPiNextCommands(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    // Do not clear or cancel status here. The heartbeat resolves getLiveCtx()
    // when it writes, and therefore follows the replacement session. Cancelling
    // at this boundary made a live run lose its footer permanently as soon as
    // it selected an issue and crossed its first session transition.
  });

  // Status entries belong to the current UI context, not to the disposed
  // context that created the run. Rebind the latest durable state as soon as
  // Pi has installed the replacement session. Terminal states need one paint;
  // a live local controller also gets a fresh heartbeat.
  pi.on("session_start", (_event, ctx) => {
    setLiveCtx(ctx);
    const ownerSessionId = sessionIdentity(ctx);
    const state = activeAutoStatusRun(ctx.cwd, undefined, ownerSessionId);
    if (!state) return;
    setAutoStatusSafely(ctx, autoStatusText(
      ctx.cwd,
      Date.now(),
      state.runId,
      ownerSessionId,
      piNextRuntimeIdentity().version,
    ));
    if (
      state.status === "running" &&
      controllerPid(ctx.cwd, state.runId) === process.pid &&
      autoStatusHeartbeatCancellations.size === 0
    ) {
      startAutoStatusHeartbeat(ctx, () => state.runId);
    }
  });

  const registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
    if (name !== "pi-next") return pi.registerCommand(name, command);
    return pi.registerCommand(name, {
      ...command,
      handler: async (args, ctx) => {
        setLiveCtx(ctx);
        const auto = args.trim() === "auto";
        let preferredRunId: string | undefined;
        const stopStatus = auto
          ? startAutoStatusHeartbeat(ctx, () => preferredRunId, { replaceExisting: true })
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
          // Keep the final controller-owned status visible. A deliberate
          // `/pi-next-loop clear` is the explicit reset path.
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

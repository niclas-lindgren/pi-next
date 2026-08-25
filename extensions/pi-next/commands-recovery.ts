import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  GitHubIssueLeaseAuthority,
  issueWorkspaceIdentity,
  type IssueLeaseAuthority,
} from "./issue-leases.ts";
import { issueLeaseMatchesOwner } from "./issue-authority.ts";
import { registerPiNextCommands as registerBasePiNextCommands } from "./commands.ts";
import { currentSupervisorStatus } from "./supervisor-status.ts";
import {
  bindLiveAutoRun,
  getLiveCtx,
  getLiveCtxFor,
  liveAutoRunBinding,
  onLiveAutoRunBound,
  sessionIdentity,
  setLiveCtx,
} from "./live-ctx.ts";
import { preflightWorkflowStateProvider } from "./workflow-state-provider.ts";
import {
  listLoopStates,
  loopStateFile,
  readLoopState,
  runtimeCwdFor,
  type LoopState,
} from "./loop-state.ts";
import {
  classifyLoopStates,
  selectCurrentLoop,
} from "./loop-status.ts";
import { renderAutoProgress } from "./auto-progress.ts";
import { piNextRuntimeIdentity } from "../../src/version.ts";
import {
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

type AutoStatusBinding = {
  cwd: string;
  runId?: string;
  ownerSessionId?: string;
  sessionFile?: string;
  targetSessionFile?: string;
  /** Last exact-run paint used as a presentation-only handoff fallback. */
  lastText?: string;
  /** Immediate repaint hook for controller binding, never persisted. */
  repaint?: () => void;
  active: boolean;
  heartbeatActive: boolean;
};

/**
 * Presentation identity is established by the running command, not inferred
 * from durable history. Keep that identity separately so a replacement
 * session can repaint it before session-scoped UI state is reconstructed.
 */
const autoStatusBindings = new Set<AutoStatusBinding>();
const AUTO_STATUS_BINDING_VERSION = 1;

function sessionFile(ctx: ExtensionCommandContext): string | undefined {
  try {
    const file = ctx.sessionManager?.getSessionFile?.();
    return typeof file === "string" && file.trim() ? file : undefined;
  } catch {
    return undefined;
  }
}

function statusBindingFile(cwd: string, runId: string): string {
  const state = readLoopState(cwd, runId);
  return join(
    runtimeDir(runtimeCwdFor(cwd, state || { coordinationCwd: undefined })),
    "pi-next-loops",
    runId,
    "status-binding.json",
  );
}

function persistStatusBinding(binding: AutoStatusBinding): void {
  if (!binding.runId) return;
  try {
    writeJsonAtomic(statusBindingFile(binding.cwd, binding.runId), {
      version: AUTO_STATUS_BINDING_VERSION,
      runId: binding.runId,
      ownerSessionId: binding.ownerSessionId,
      sessionFile: binding.sessionFile,
      targetSessionFile: binding.targetSessionFile,
      lastText: binding.lastText,
      active: binding.active,
    });
  } catch {
    // Presentation persistence is best effort; the in-memory handoff remains
    // authoritative for the current host process and never affects workflow.
  }
}

function readPersistedStatusBinding(cwd: string, runId: string): AutoStatusBinding | undefined {
  try {
    const value = JSON.parse(readFileSync(statusBindingFile(cwd, runId), "utf8")) as Partial<AutoStatusBinding> & { version?: number };
    if (value.version !== AUTO_STATUS_BINDING_VERSION || value.runId !== runId || value.active !== true) return undefined;
    return {
      cwd,
      runId,
      ownerSessionId: value.ownerSessionId,
      sessionFile: value.sessionFile,
      targetSessionFile: value.targetSessionFile,
      lastText: value.lastText,
      active: true,
      heartbeatActive: false,
    };
  } catch {
    return undefined;
  }
}

function findReplacementBinding(
  ctx: ExtensionCommandContext,
  event: { previousSessionFile?: string },
): AutoStatusBinding | undefined {
  const currentFile = sessionFile(ctx);
  const previousFile = event.previousSessionFile;
  const currentSessionId = sessionIdentity(ctx);
  const inMemory = [...autoStatusBindings].find((binding) =>
    binding.active &&
    binding.cwd === ctx.cwd &&
    ((currentFile && binding.targetSessionFile === currentFile) ||
      (previousFile && binding.sessionFile === previousFile) ||
      (!currentFile && !previousFile && binding.ownerSessionId === currentSessionId)),
  );
  if (inMemory) return inMemory;

  // The host reloads extension instances during session replacement. Recover
  // the presentation-only handoff without treating it as workflow authority.
  for (const state of listLoopStates(ctx.cwd)) {
    const binding = readPersistedStatusBinding(ctx.cwd, state.runId);
    if (!binding) continue;
    if (
      (currentFile && binding.targetSessionFile === currentFile) ||
      (previousFile && binding.sessionFile === previousFile)
    ) {
      autoStatusBindings.add(binding);
      return binding;
    }
  }
  return undefined;
}

// Bind presentation identity as soon as the controller creates the run, not
// only on the next heartbeat or at session shutdown. Workflow authority stays
// in the lease/controller state; this observer only makes the UI handoff
// durable before the first host transition can occur.
onLiveAutoRunBound((ctx, runId) => {
  const ownerSessionId = sessionIdentity(ctx);
  const binding = [...autoStatusBindings].find((candidate) =>
    candidate.active &&
    candidate.cwd === ctx.cwd &&
    (!ownerSessionId || candidate.ownerSessionId === ownerSessionId) &&
    (!candidate.runId || candidate.runId === runId),
  );
  if (!binding) return;
  binding.runId = runId;
  binding.ownerSessionId = ownerSessionId || binding.ownerSessionId;
  binding.sessionFile = sessionFile(ctx) || binding.sessionFile;
  persistStatusBinding(binding);
  binding.repaint?.();
});

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controllerLockFile(cwd: string, state: LoopState): string {
  return join(runtimeDir(runtimeCwdFor(cwd, state)), "pi-next-loops", state.runId, "controller.lock");
}

function controllerPid(cwd: string, state: LoopState): number | undefined {
  const path = controllerLockFile(cwd, state);
  if (!existsSync(path)) return undefined;
  try {
    const lock = readFileSync(path, "utf8");
    const lockRunId = lock.match(/^run_id=(.+)$/m)?.[1]?.trim();
    if (lockRunId !== state.runId) return undefined;
    const pid = Number.parseInt(lock.match(/^pid=(\d+)$/m)?.[1] || "0", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function locallyAbandoned(cwd: string, state: LoopState): boolean {
  const pid = controllerPid(cwd, state);
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
  const records = classifyLoopStates(cwd, listLoopStates(cwd));
  return selectCurrentLoop(records, preferredRunId, ownerSessionId).current?.state;
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
  // current context at call time; a weak fallback supports direct/test callers
  // without retaining the full host session graph in the heartbeat closure.
  setLiveCtx(ctx);
  const fallbackCtx = new WeakRef(ctx);
  const cwd = ctx.cwd;
  const startedAt = Date.now();
  const version = piNextRuntimeIdentity().version;
  const ownerSessionId = sessionIdentity(ctx);
  const initialRunId = preferredRunId();
  const binding = initialRunId
    ? [...autoStatusBindings].find((candidate) =>
      candidate.active && candidate.cwd === cwd && candidate.runId === initialRunId,
    ) || {
      cwd,
      runId: initialRunId,
      ownerSessionId,
      sessionFile: sessionFile(ctx),
      active: true,
      heartbeatActive: false,
    }
    : {
      cwd,
      ownerSessionId,
      sessionFile: sessionFile(ctx),
      active: true,
      heartbeatActive: false,
    };
  autoStatusBindings.add(binding);
  binding.active = true;
  binding.heartbeatActive = true;
  let active = true;
  let firstUpdate = true;
  let boundRunId: string | undefined = binding.runId;
  const cancel = () => {
    if (!active) return;
    active = false;
    binding.heartbeatActive = false;
    clearInterval(timer);
    autoStatusHeartbeatCancellations.delete(cancel);
  };
  const stop = () => {
    if (!active) return;
    // Render once more after the controller has settled. Ordinary command
    // completion is not a request to clear the footer; the durable terminal
    // state is the useful handoff to the operator and to a replacement
    // session. Shutdown cancels first, so this never touches a disposed ctx.
    update(fallbackCtx.deref());
    binding.active = false;
    persistStatusBinding(binding);
    autoStatusBindings.delete(binding);
    cancel();
  };
  autoStatusHeartbeatCancellations.add(cancel);

  const update = (finalCtx?: ExtensionCommandContext) => {
    // session_shutdown cancels the timer before the replacement context is
    // disposed. This guard also handles an already queued timer callback.
    if (!active) return;
    // The heartbeat intentionally has no strong fallback to the initial host
    // context. Command finalization may, however, still have a valid direct
    // context after the supervisor has cleared the live bridge, so stop()
    // supplies it for one final exact-run repaint.
    const boundSessionId = binding.ownerSessionId || ownerSessionId;
    const liveCtx = getLiveCtxFor(cwd, boundSessionId) ??
      (boundSessionId === ownerSessionId ? getLiveCtx() : undefined) ??
      finalCtx;
    if (liveCtx) {
      // Bind once to this session's own durable run. Before that happens,
      // deliberately render a neutral state instead of borrowing the newest
      // run from the repository runtime directory.
      boundRunId ||= preferredRunId() || liveAutoRunBinding(liveCtx) || activeAutoStatusRun(
        cwd,
        undefined,
        ownerSessionId,
      )?.runId;
      if (boundRunId && binding.runId !== boundRunId) {
        binding.runId = boundRunId;
        binding.ownerSessionId = ownerSessionId;
        binding.sessionFile = sessionFile(liveCtx);
        persistStatusBinding(binding);
      }
      const text = autoStatusText(
        cwd,
        startedAt,
        boundRunId,
        ownerSessionId,
        version,
        Boolean(options.replaceExisting && firstUpdate),
      );
      setAutoStatusSafely(liveCtx, text);
      if (boundRunId && binding.runId === boundRunId) binding.lastText = text;
    }
    firstUpdate = false;
  };
  // Controller binding can happen after the heartbeat's neutral first paint;
  // expose the same exact-run update synchronously so recovery does not wait
  // for AUTO_STATUS_INTERVAL_MS to repair the footer.
  binding.repaint = update;
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
      !state.autoResumeBlockedAt &&
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

export interface RejectedLegacyAutoRun {
  runId?: string;
  blockedReason?: string;
}

/**
 * `production-lifecycle.ts` (the unified scheduler) never writes
 * `state.activeLease`, so `recoverableAbandonedAutoRun`'s candidate filter
 * (which requires it) can only ever match a legacy `loop-controller.ts`
 * -produced abandoned run — never a fresh-scheduler-produced one. The
 * retired ForegroundSupervisor/loop-controller.ts state machine that used to
 * reactivate such a run no longer exists (issue #165), so a matching
 * candidate is rejected explicitly with the same actionable migration
 * guidance `/pi-next-loop resume` gives for legacy state, instead of being
 * silently misinterpreted or launched through a state machine that has been
 * retired.
 */
async function rejectAbandonedLegacyAutoRun(cwd: string): Promise<RejectedLegacyAutoRun> {
  const state = await recoverableAbandonedAutoRun(cwd);
  if (!state) return {};
  // This terminal state can never become explicitly recoverable on a later
  // pass: its status and lease do not change just by asking again. Mark it
  // so `recoverableAbandonedAutoRun` stops proposing it as a candidate on
  // every subsequent `auto` invocation, without altering the durable status
  // (e.g. a deliberate operator "stopped" stays "stopped").
  writeJsonAtomic(loopStateFile(cwd, state.runId), {
    ...state,
    autoResumeBlockedAt: new Date().toISOString(),
  });
  return {
    runId: state.runId,
    blockedReason:
      `Run ${state.runId} is legacy pre-migration state (status "${state.status}") and can no longer be resumed automatically. ` +
      `Inspect it with "/pi-next-loop status ${state.runId} verbose", then either finish any in-progress work manually or discard the run and start a fresh "/pi-next auto" (the retired ForegroundSupervisor/loop-controller.ts state machine can no longer resume it).`,
  };
}

/**
 * Wrap only the public /pi-next command registration. All ordinary command
 * behavior remains in commands.ts; this adds restart recovery for `auto`
 * before that handler would create a competing run with a new lease identity.
 */
export function clearAutoStatus(ctx: ExtensionCommandContext): void {
  setAutoStatusSafely(ctx, undefined);
  for (const binding of autoStatusBindings) {
    if (binding.cwd === ctx.cwd && binding.ownerSessionId === sessionIdentity(ctx)) {
      binding.active = false;
      persistStatusBinding(binding);
    }
  }
}

export function registerPiNextCommands(pi: ExtensionAPI): void {
  pi.on("session_shutdown", (event, ctx) => {
    // Never clear the old context: the host owns teardown and may clear its
    // session-scoped status between these two lifecycle callbacks. Record the
    // exact bound run and destination so session_start can repaint it without
    // consulting the ambiguous repository-wide selector.
    const oldFile = sessionFile(ctx);
    const oldSessionId = sessionIdentity(ctx);
    const controllerBoundRunId = liveAutoRunBinding(ctx);
    for (const binding of autoStatusBindings) {
      const belongsToOldSession = oldFile
        ? binding.sessionFile === oldFile ||
          (Boolean(oldSessionId) && binding.ownerSessionId === oldSessionId)
        : Boolean(oldSessionId) && binding.ownerSessionId === oldSessionId;
      if (!binding.active || binding.cwd !== ctx.cwd || !belongsToOldSession) continue;
      if (!binding.runId && controllerBoundRunId) binding.runId = controllerBoundRunId;
      binding.sessionFile = oldFile || binding.sessionFile;
      binding.targetSessionFile = event.targetSessionFile;
      persistStatusBinding(binding);
    }
  });

  // Status entries belong to the current UI context, not to the disposed
  // context that created the run. A bound handoff is painted synchronously;
  // only an unbound session uses conservative status discovery.
  pi.on("session_start", (event, ctx) => {
    setLiveCtx(ctx);
    const binding = findReplacementBinding(ctx, event);
    if (binding?.runId) {
      // Rebind the supervisor run to the replacement context. This keeps
      // concurrent runs from borrowing the process-global newest context.
      bindLiveAutoRun(ctx, binding.runId);
      const ownerSessionId = sessionIdentity(ctx);
      const state = activeAutoStatusRun(ctx.cwd, binding.runId, ownerSessionId);
      // A missing exact state must not fall back to another historical run.
      // The last exact-run paint is safe as a presentation-only handoff while
      // an atomic durable-state write is becoming visible; it never grants
      // authority or changes workflow selection.
      if (!state && !binding.lastText) return;
      binding.ownerSessionId = ownerSessionId || binding.ownerSessionId;
      binding.sessionFile = sessionFile(ctx) || binding.targetSessionFile || binding.sessionFile;
      binding.targetSessionFile = undefined;
      persistStatusBinding(binding);
      const text = state
        ? autoStatusText(
          ctx.cwd,
          Date.now(),
          binding.runId,
          ownerSessionId,
          piNextRuntimeIdentity().version,
        )
        : binding.lastText!;
      setAutoStatusSafely(ctx, text);
      binding.lastText = text;
      if (
        state?.status === "running" &&
        controllerPid(ctx.cwd, state) === process.pid &&
        !binding.heartbeatActive
      ) {
        startAutoStatusHeartbeat(ctx, () => binding.runId);
      }
      return;
    }

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
      controllerPid(ctx.cwd, state) === process.pid &&
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
            // Recovery can take over an abandoned lease and prepare its
            // canonical worktree, so provider validation must precede it as
            // well as the normal claim/worker path. Keep this failure separate
            // from authority/recovery failures.
            try {
              await preflightWorkflowStateProvider(ctx.cwd);
            } catch (error) {
              safeNotify(
                ctx,
                `Workflow state provider preflight failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              return;
            }
            try {
              // No candidate found by `recoverableAbandonedAutoRun` can ever
              // be a fresh-scheduler-produced run (see
              // `rejectAbandonedLegacyAutoRun`'s doc comment); reject it
              // explicitly with actionable guidance instead of attempting to
              // resume/launch it, then fall through to the normal handler so
              // a new run can still start.
              const outcome = await rejectAbandonedLegacyAutoRun(ctx.cwd);
              if (outcome.runId) preferredRunId = outcome.runId;
              if (outcome.blockedReason) {
                safeNotify(ctx, outcome.blockedReason, "warning");
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

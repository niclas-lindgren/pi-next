import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Single source of truth for "the currently live session `ExtensionCommandContext`".
 *
 * The host replaces `ctx` wholesale on a genuine `/new`, fork, switch,
 * reload, or resume transition; a closure that keeps its own captured `ctx`
 * variable becomes invalid the instant one of those fires, and throws
 * "extension ctx is stale..." the next time it touches `ctx.ui`.
 *
 * Worker/model freshness does not require this bridge: ordinary pi-next
 * progression stays in one host session and launches isolated child workers.
 * The bridge remains for callbacks that outlive a genuine host lifecycle
 * boundary. Every place that receives a fresh `ctx` from the host calls
 * `setLiveCtx()`, and callbacks resolve the live context at call time instead
 * of closing over a context that may have been disposed.
 */
let current: ExtensionCommandContext | undefined;
// Only the current host context is a strong bridge. Historical session keys
// are weak so an external replacement cannot leave a disposed Pi session graph
// alive until a durable run happens to settle.
const contexts = new Map<string, WeakRef<ExtensionCommandContext>>();
const boundRunIds = new Map<string, string>();
const autoRunBoundListeners = new Set<(ctx: ExtensionCommandContext, runId: string) => void>();

function runBindingKey(ctx: unknown): string | undefined {
  const typed = ctx as { cwd?: string } | undefined;
  const cwd = typed?.cwd;
  const session = sessionIdentity(ctx);
  return cwd && session ? `${cwd}\u0000${session}` : undefined;
}

export function setLiveCtx(ctx: ExtensionCommandContext): void {
  current = ctx;
  const key = runBindingKey(ctx);
  if (key) contexts.set(key, new WeakRef(ctx));
  // Contexts that were never bound to an active run are only command-entry
  // leftovers. Drop their keys as soon as a newer host context arrives.
  for (const [oldKey] of contexts) {
    if (oldKey !== key && oldKey.startsWith(`${ctx.cwd}\u0000`) && !boundRunIds.has(oldKey)) {
      contexts.delete(oldKey);
    }
  }
}

/** Resolve the live context for one cwd/session pair without borrowing another
 * concurrently running supervisor's UI context. */
export function getLiveCtxFor(cwd: string, sessionId?: string): ExtensionCommandContext | undefined {
  if (sessionId) {
    const key = `${cwd}\u0000${sessionId}`;
    const ctx = contexts.get(key)?.deref();
    if (!ctx) contexts.delete(key);
    return ctx;
  }
  return current?.cwd === cwd ? current : undefined;
}

/** Bind presentation to a run at the controller's creation boundary. */
export function bindLiveAutoRun(ctx: ExtensionCommandContext, runId: string): void {
  const key = runBindingKey(ctx);
  if (key) {
    // A genuine host replacement rebinds the same durable run under a new
    // session key. Retire its old bridge immediately; it is not needed for
    // authority/recovery and must not retain the disposed host graph.
    for (const [oldKey, oldRunId] of boundRunIds) {
      if (oldRunId === runId && oldKey !== key && oldKey.startsWith(`${ctx.cwd}\u0000`)) {
        boundRunIds.delete(oldKey);
        contexts.delete(oldKey);
      }
    }
    boundRunIds.set(key, runId);
    contexts.set(key, new WeakRef(ctx));
  }
  for (const listener of autoRunBoundListeners) {
    try {
      listener(ctx, runId);
    } catch {
      // Presentation observers are diagnostic-only and never affect control.
    }
  }
}

/** Observe controller binding creation without coupling loop control to the
 * footer implementation. The callback is presentation-only. */
export function onLiveAutoRunBound(
  listener: (ctx: ExtensionCommandContext, runId: string) => void,
): () => void {
  autoRunBoundListeners.add(listener);
  return () => autoRunBoundListeners.delete(listener);
}

export function liveAutoRunBinding(ctx: unknown): string | undefined {
  const key = runBindingKey(ctx);
  return key ? boundRunIds.get(key) : undefined;
}

/** Release presentation-only identity after its supervisor has settled. */
export function clearLiveAutoRunBinding(cwd: string, runId: string): void {
  for (const [key, boundRunId] of boundRunIds) {
    if (boundRunId !== runId || !key.startsWith(`${cwd}\u0000`)) continue;
    boundRunIds.delete(key);
    // Once the run settles, do not retain its host context graph. Keep a
    // context only when another active run still owns the same session key.
    if (![...boundRunIds.keys()].some((other) => other === key)) contexts.delete(key);
  }
}

export function getLiveCtx(): ExtensionCommandContext | undefined {
  return current;
}

/** Resolve the presentation context bound to one supervisor run. */
export function getLiveCtxForRun(runId: string): ExtensionCommandContext | undefined {
  if (current && liveAutoRunBinding(current) === runId) return current;
  for (const [key, boundRunId] of boundRunIds) {
    if (boundRunId !== runId) continue;
    const ctx = contexts.get(key)?.deref();
    if (ctx) return ctx;
    contexts.delete(key);
  }
  return undefined;
}

/** Clear the host-context reference once no foreground supervisor remains. */
export function clearLiveCtx(): void {
  current = undefined;
  contexts.clear();
}

/**
 * Stable host-session identity used to scope presentation state. A run may
 * replace its command context while progressing, but its originating session
 * identity remains the boundary that prevents another session's durable run
 * from being selected as a footer fallback.
 */
export function sessionIdentity(ctx: unknown): string | undefined {
  try {
    const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager;
    const id = manager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Test-only reset so unrelated specs never observe a leaked singleton. */
export function __resetLiveCtxForTests(): void {
  current = undefined;
  contexts.clear();
  boundRunIds.clear();
}

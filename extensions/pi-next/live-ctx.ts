import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Single source of truth for "the currently live session `ExtensionCommandContext`".
 *
 * The host replaces `ctx` wholesale on every `ctx.newSession()` / `fork()` /
 * `switchSession()` / `reload()` transition; a closure that keeps its own
 * captured `ctx` variable becomes invalid the instant one of those fires,
 * and throws "extension ctx is stale..." the next time it touches `ctx.ui`.
 * pi-next's step-transition loop (`driveLoop` in loop-controller.ts) calls
 * `ctx.newSession()` on essentially every step, so any callback that
 * outlives one step boundary — worker progress timers, worker-activity
 * events, lease-heartbeat notifications, the live worker-display widget —
 * was previously guaranteed to hit a stale `ctx` and get silently swallowed
 * by `guardedHostCall()` (visible only as `hostCallSwallowed` crash-log
 * noise, indistinguishable from an idle worker).
 *
 * Fix: every place that receives a fresh `ctx` from the host (the initial
 * command invocation, and every `withSession` callback) calls
 * `setLiveCtx()`. Every callback that may fire after such a boundary
 * resolves `getLiveCtx()` at call time instead of closing over a `ctx`
 * variable, so it always targets whatever session is actually live.
 */
let current: ExtensionCommandContext | undefined;

export function setLiveCtx(ctx: ExtensionCommandContext): void {
  current = ctx;
}

export function getLiveCtx(): ExtensionCommandContext | undefined {
  return current;
}

/** Clear the host-context reference once no foreground supervisor remains. */
export function clearLiveCtx(): void {
  current = undefined;
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
}

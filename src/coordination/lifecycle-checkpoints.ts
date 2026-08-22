import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Recovery-relevant lifecycle boundaries. These names are intentionally coarse:
 * each checkpoint represents a durable/idempotency boundary where restart must
 * reconcile authority, Git, leases, worker evidence, or cleanup ordering.
 */
export const RECOVERY_LIFECYCLE_CHECKPOINTS = [
  "candidate_selected",
  "lease_claimed",
  "workspace_prepared",
  "authority_loaded",
  "plan_ready",
  "worker_started",
  "worker_finished",
  "verification_finished",
  "candidate_committed",
  "promotion_started",
  "promotion_succeeded",
  "reachability_proven",
  "authority_reconciled",
  "pending_verification_recorded",
  "issue_closed",
  "lease_released",
  "workspace_cleaned",
] as const;

export type RecoveryLifecycleCheckpoint = (typeof RECOVERY_LIFECYCLE_CHECKPOINTS)[number];
export type LifecycleCheckpointPosition = "before" | "after";
export type LifecycleFaultAction = "throw" | "cancel" | "exit";

const CHECKPOINT_SET = new Set<string>(RECOVERY_LIFECYCLE_CHECKPOINTS);

export interface LifecycleFaultInjectionOptions {
  checkpoint: RecoveryLifecycleCheckpoint;
  position: LifecycleCheckpointPosition;
  /** Defaults to `throw`; `exit` is intentionally opt-in for subprocess tests. */
  action?: LifecycleFaultAction;
  /** Defaults to true so one run can crash exactly once at the target point. */
  once?: boolean;
  exitCode?: number;
}

interface LifecycleFaultInjectionState extends Required<Omit<LifecycleFaultInjectionOptions, "exitCode">> {
  exitCode: number;
  triggered: boolean;
}

export class LifecycleCheckpointFault extends Error {
  readonly code = "LIFECYCLE_CHECKPOINT_FAULT";

  constructor(
    readonly checkpoint: RecoveryLifecycleCheckpoint,
    readonly position: LifecycleCheckpointPosition,
    readonly action: LifecycleFaultAction,
  ) {
    super(`Injected lifecycle fault at checkpoint ${checkpoint} (${position}) via ${action}`);
    this.name = "LifecycleCheckpointFault";
  }
}

const faultInjection = new AsyncLocalStorage<LifecycleFaultInjectionState>();

export function isRecoveryLifecycleCheckpoint(value: string): value is RecoveryLifecycleCheckpoint {
  return CHECKPOINT_SET.has(value);
}

export function parseLifecycleFaultInjection(value: string): LifecycleFaultInjectionOptions {
  const [checkpoint, position, action = "throw"] = value.split(":");
  if (!isRecoveryLifecycleCheckpoint(checkpoint)) {
    throw new Error(`Unknown lifecycle fault checkpoint: ${checkpoint}`);
  }
  if (position !== "before" && position !== "after") {
    throw new Error(`Lifecycle fault position must be before or after: ${value}`);
  }
  if (action !== "throw" && action !== "cancel" && action !== "exit") {
    throw new Error(`Lifecycle fault action must be throw, cancel, or exit: ${value}`);
  }
  return { checkpoint, position, action };
}

function normalize(options: LifecycleFaultInjectionOptions): LifecycleFaultInjectionState {
  return {
    checkpoint: options.checkpoint,
    position: options.position,
    action: options.action ?? "throw",
    once: options.once ?? true,
    exitCode: options.exitCode ?? 70,
    triggered: false,
  };
}

/**
 * Test/dev-only scoped fault injection. Production code has no active fault
 * behavior unless a caller explicitly wraps execution with this function or
 * enables the guarded environment parser below.
 */
export async function withLifecycleFaultInjection<T>(
  options: LifecycleFaultInjectionOptions,
  run: () => Promise<T> | T,
): Promise<T> {
  return faultInjection.run(normalize(options), async () => run());
}

export function lifecycleFaultInjectionFromEnv(env: NodeJS.ProcessEnv = process.env): LifecycleFaultInjectionOptions | undefined {
  if (env.PI_NEXT_ENABLE_LIFECYCLE_FAULT_INJECTION !== "1") return undefined;
  const value = env.PI_NEXT_LIFECYCLE_FAULT_AT;
  return value ? parseLifecycleFaultInjection(value) : undefined;
}

export function emitLifecycleCheckpoint(
  checkpoint: RecoveryLifecycleCheckpoint,
  position: LifecycleCheckpointPosition,
): void {
  const state = faultInjection.getStore();
  if (!state) return;
  if (state.once && state.triggered) return;
  if (state.checkpoint !== checkpoint || state.position !== position) return;
  state.triggered = true;
  if (state.action === "exit") {
    // Intentionally only reachable when explicitly configured. Unit tests use
    // the throwing mode; subprocess crash tests may opt into real termination.
    process.exit(state.exitCode);
  }
  throw new LifecycleCheckpointFault(checkpoint, position, state.action);
}

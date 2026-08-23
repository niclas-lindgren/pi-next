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
  "candidate_pushed",
  "promotion_started",
  "promotion_pushed",
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

export interface RecoveryLifecycleCheckpointCoverage {
  /** Human-readable boundary contract; keep free of issue/private data. */
  description: string;
  /** True when the boundary has a durable lifecycle-journal fact. */
  durableJournalEvent: boolean;
  /** Invariant that crash/restart tests must preserve for this boundary. */
  invariant: string;
}

export const RECOVERY_LIFECYCLE_CHECKPOINT_COVERAGE = {
  candidate_selected: {
    description: "A work item has been selected, before ownership is granted.",
    durableJournalEvent: true,
    invariant: "restart may re-evaluate candidates but must not infer ownership from selection",
  },
  lease_claimed: {
    description: "Live authority/lease granted ownership for the canonical issue identity.",
    durableJournalEvent: true,
    invariant: "no duplicate fresh owner or claim after restart",
  },
  workspace_prepared: {
    description: "Canonical issue worktree/branch identity is established or recovered.",
    durableJournalEvent: true,
    invariant: "unique dirty/unintegrated work is preserved and never silently replaced",
  },
  authority_loaded: {
    description: "Current authority snapshot has been loaded for planning or mutable work.",
    durableJournalEvent: true,
    invariant: "mutable transitions fail closed when authority freshness cannot be proven",
  },
  plan_ready: {
    description: "The bounded plan or repaired plan is ready for worker dispatch.",
    durableJournalEvent: true,
    invariant: "planning retries are idempotent or fail safe without granting authority",
  },
  worker_started: {
    description: "A bounded implementation worker has been dispatched.",
    durableJournalEvent: true,
    invariant: "restart must not launch duplicate implementation when durable completion evidence exists",
  },
  worker_finished: {
    description: "The implementation worker result/evidence has settled.",
    durableJournalEvent: true,
    invariant: "durable worker completion is replayable without resurrecting implementation unnecessarily",
  },
  verification_finished: {
    description: "Mechanical verification has settled with pass/fail/unproven evidence.",
    durableJournalEvent: true,
    invariant: "promotion remains blocked unless verification evidence is current and acceptable",
  },
  candidate_committed: {
    description: "Candidate implementation is durable as a local commit SHA before any externally visible branch push.",
    durableJournalEvent: true,
    invariant: "restart must not duplicate the candidate commit side effect",
  },
  candidate_pushed: {
    description: "The canonical issue branch has been pushed to the configured remote.",
    durableJournalEvent: true,
    invariant: "restart reconciles the remote branch by SHA instead of duplicating candidate commit/push side effects",
  },
  promotion_started: {
    description: "Guarded finalization/promotion has begun.",
    durableJournalEvent: true,
    invariant: "promotion retries are idempotent or fail closed against Git/authority evidence",
  },
  promotion_pushed: {
    description: "The integration commit has been pushed to the configured remote main.",
    durableJournalEvent: true,
    invariant: "restart must not duplicate merge or push after remote-main integration evidence",
  },
  promotion_succeeded: {
    description: "Integration success has been durably recorded after the remote-main push.",
    durableJournalEvent: true,
    invariant: "restart must reconcile by SHA rather than repeating durable integration side effects",
  },
  reachability_proven: {
    description: "The candidate/integration SHA is proven reachable from the configured remote main.",
    durableJournalEvent: true,
    invariant: "cleanup and closure require durable reachability proof first",
  },
  authority_reconciled: {
    description: "Fresh authority has been checked after integration and before completion.",
    durableJournalEvent: true,
    invariant: "no close before current authority/freshness proof",
  },
  pending_verification_recorded: {
    description: "External or pending verification state is durably recorded.",
    durableJournalEvent: true,
    invariant: "crash after pending verification does not resurrect implementation unnecessarily",
  },
  issue_closed: {
    description: "Authority completion/closure side effect has been performed.",
    durableJournalEvent: true,
    invariant: "closure retry reconciles authority instead of closing stale work",
  },
  lease_released: {
    description: "The active issue lease has been released or made non-owning.",
    durableJournalEvent: true,
    invariant: "lease release is idempotent and never substitutes for integration proof",
  },
  workspace_cleaned: {
    description: "Local disposable workspace cleanup has completed.",
    durableJournalEvent: true,
    invariant: "cleanup never precedes durable integration/reachability and never deletes unique work",
  },
} as const satisfies Record<RecoveryLifecycleCheckpoint, RecoveryLifecycleCheckpointCoverage>;

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

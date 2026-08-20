import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runtimeDir, writeJsonAtomic } from "./util.ts";

const MAX_EVENTS = 200;

export type LifecycleEventName =
  | "checkpoint_pushed"
  | "checkpoint_recovered"
  | "promotion_succeeded"
  | "promotion_failed"
  | "build_classified"
  | "claim_acquired"
  | "claim_rejected"
  | "claim_released"
  | "claim_expired"
  | "claim_taken_over"
  | "legacy_branch_adopted"
  | "legacy_worktree_migrated"
  | "project_status_sync_attempted"
  | "project_status_sync_failed"
  | "project_status_synced"
  | "generation_teardown"
  | "plan_repaired"
  | "plan_reconciled"
  | "workflow_artifact_quarantined"
  | "worker_recovery"
  | "issue_contained";

export interface LifecycleEvent {
  event: LifecycleEventName;
  issueNumber: number;
  runId: string;
  agent?: string;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  outcome: "success" | "failure" | "recovered" | "rejected" | "build" | "skip";
  deployRelevant?: boolean;
  reasonCode?: string;
  at: string;
  /**
   * Structured pi-next extension-generation teardown/replacement diagnostics
   * (#583), populated only on `event: "generation_teardown"`. Consumable by
   * #578's agent-feedback pipeline without requiring #578 itself.
   */
  generation?: {
    generationId: string;
    teardownReason: string;
    tasksTracked: number;
    tasksSettled: number;
    timedOut: boolean;
    tasksCancelled: number;
    subprocessesTerminated: number;
  };
  repair?: {
    paths: string[];
    fields: string[];
    authorityFingerprint?: string;
  };
  /** Structured issue-local containment evidence; the worktree is preserved. */
  containment?: {
    scope: "issue-local";
    stage: string;
    code: string;
    paths: string[];
    leaseReleased: boolean;
  };
}

interface LifecycleState {
  version: 1;
  events: LifecycleEvent[];
}

export function lifecycleTelemetryFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-lifecycle.json");
}

function readState(cwd: string): LifecycleState {
  const file = lifecycleTelemetryFile(cwd);
  if (!existsSync(file)) return { version: 1, events: [] };
  try {
    const value = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<LifecycleState>;
    return {
      version: 1,
      events: Array.isArray(value.events)
        ? value.events.slice(-MAX_EVENTS)
        : [],
    };
  } catch {
    return { version: 1, events: [] };
  }
}

function reasonCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("main changed")) return "stale_main";
  if (normalized.includes("verification")) return "verification_failed";
  if (normalized.includes("dirty") || normalized.includes("conflict"))
    return "unsafe_git_state";
  if (normalized.includes("branch")) return "branch_guard";
  return "operation_failed";
}

export function recentLifecycleEventNames(cwd: string, limit = 20): string[] {
  return readState(cwd).events.slice(-Math.max(1, Math.min(50, limit))).map((event) =>
    event.reasonCode ? `${event.event}:${event.reasonCode}` : event.event,
  );
}

export function recordLifecycleEvent(
  cwd: string,
  event: Omit<LifecycleEvent, "at"> & { at?: string },
): void {
  const state = readState(cwd);
  const safe: LifecycleEvent = {
    event: event.event,
    issueNumber: event.issueNumber,
    runId: event.runId,
    agent: event.agent,
    sessionId: event.sessionId,
    worktree: event.worktree,
    branch: event.branch,
    outcome: event.outcome,
    deployRelevant: event.deployRelevant,
    reasonCode: event.reasonCode,
    at: event.at || new Date().toISOString(),
    generation: event.generation,
    repair: event.repair,
    containment: event.containment,
  };
  writeJsonAtomic(lifecycleTelemetryFile(cwd), {
    version: 1,
    events: [...state.events, safe].slice(-MAX_EVENTS),
  });
}

export function failureReasonCode(message: string): string {
  return reasonCode(message);
}

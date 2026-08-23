import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  appendLifecycleJournal,
  type LifecycleJournalAppendInput,
  type LifecycleJournalEventName,
} from "../../src/coordination/lifecycle-journal.ts";
import {
  emitLifecycleCheckpoint,
  isRecoveryLifecycleCheckpoint,
} from "../../src/coordination/lifecycle-checkpoints.ts";
import { runtimeDir } from "./util.ts";

interface LegacyLifecycleObservation {
  event: string;
  issueNumber: number;
  runId: string;
  agent?: string;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  outcome: string;
  reasonCode?: string;
  at: string;
  repair?: { authorityFingerprint?: string };
  containment?: {
    scope: string;
    stage: string;
    code: string;
    leaseReleased: boolean;
  };
}

function journalStem(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "run";
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return `${safe}-${digest}`;
}

export function piLifecycleJournalFile(cwd: string, runId: string): string {
  return join(runtimeDir(cwd), "journal", `${journalStem(runId)}.jsonl`);
}

function legacyTelemetryFile(cwd: string): string {
  return join(runtimeDir(cwd), "pi-next-lifecycle.json");
}

function ensureLegacyBaseline(cwd: string, runId: string): void {
  const file = piLifecycleJournalFile(cwd, runId);
  if (existsSync(file) || !existsSync(legacyTelemetryFile(cwd))) return;
  appendLifecycleJournal(file, {
    runId,
    event: "baseline_imported",
    idempotencyKey: "baseline:legacy-runtime-v1",
    payload: {
      source: "pi-next-lifecycle-v1",
      note: "Journal introduced for an existing runtime; live authority and Git remain authoritative for pre-journal history.",
    },
  });
}

/**
 * Durable Pi-host journal write. Callers provide only coordination facts;
 * schema validation rejects prompt/transcript/secret-style payload fields.
 */
export function recordPiLifecycleJournal(
  cwd: string,
  input: LifecycleJournalAppendInput,
): void {
  ensureLegacyBaseline(cwd, input.runId);
  const checkpoint = isRecoveryLifecycleCheckpoint(input.event) ? input.event : undefined;
  if (checkpoint) emitLifecycleCheckpoint(checkpoint, "before");
  appendLifecycleJournal(piLifecycleJournalFile(cwd, input.runId), input);
  if (checkpoint) emitLifecycleCheckpoint(checkpoint, "after");
}

export function currentPiRunId(): string | undefined {
  return process.env.PI_NEXT_RUN_ID?.trim() || undefined;
}

export function currentPiIssueNumber(): number | undefined {
  const raw = process.env.PI_NEXT_ISSUE_NUMBER?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function recordCurrentPiLifecycleJournal(
  cwd: string,
  input: Omit<LifecycleJournalAppendInput, "runId"> & { runId?: string },
): void {
  const runId = input.runId?.trim() || currentPiRunId();
  if (!runId) return;
  recordPiLifecycleJournal(cwd, { ...input, runId });
}

function mappedEvent(observation: LegacyLifecycleObservation): LifecycleJournalEventName | undefined {
  switch (observation.event) {
    case "claim_acquired": return "lease_claimed";
    case "claim_rejected": return "lease_rejected";
    case "claim_taken_over": return "lease_taken_over";
    case "claim_released": return "lease_released";
    case "legacy_branch_adopted":
    case "legacy_worktree_migrated":
    case "legacy_worktree_salvaged": return "workspace_prepared";
    case "checkpoint_pushed": return undefined;
    case "promotion_succeeded": return undefined;
    case "plan_reconciled": return "authority_reconciled";
    case "issue_contained": return "failure_recorded";
    case "worker_stalled": return observation.outcome === "failure" ? "failure_recorded" : undefined;
    case "worker_recovery": return observation.outcome === "failure" ? "failure_recorded" : undefined;
    default: return undefined;
  }
}

/**
 * Compatibility bridge from the existing bounded rolling telemetry recorder.
 * This preserves old diagnostics while starting a durable per-run history for
 * recovery-relevant events already emitted by production code.
 */
export function journalLegacyLifecycleObservation(
  cwd: string,
  observation: LegacyLifecycleObservation,
): void {
  const event = mappedEvent(observation);
  if (!event || !observation.runId) return;
  const payload: LifecycleJournalAppendInput["payload"] = {
    ...(observation.agent ? { agent: observation.agent } : {}),
    ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
    ...(observation.branch ? { branch: observation.branch } : {}),
    ...(observation.worktree ? { worktree: observation.worktree } : {}),
    ...(observation.reasonCode ? { reasonCode: observation.reasonCode } : {}),
  };
  if (observation.repair?.authorityFingerprint) {
    payload.authorityFingerprint = observation.repair.authorityFingerprint;
  }
  if (observation.containment) {
    payload.scope = observation.containment.scope;
    payload.stage = observation.containment.stage;
    payload.reasonCode = observation.containment.code;
  }
  recordPiLifecycleJournal(cwd, {
    runId: observation.runId,
    ...(observation.issueNumber > 0 ? { issueNumber: observation.issueNumber } : {}),
    event,
    at: observation.at,
    idempotencyKey: `legacy:${observation.event}:${observation.issueNumber}:${observation.at}`,
    payload,
  });
}

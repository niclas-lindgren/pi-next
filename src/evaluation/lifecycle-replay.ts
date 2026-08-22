import { readFileSync } from "node:fs";

import {
  LIFECYCLE_JOURNAL_VERSION,
  materializeLifecycleJournal,
  type LifecycleJournalAppendInput,
  type LifecycleJournalRecord,
  type LifecycleJournalState,
} from "../coordination/lifecycle-journal.ts";

export const LIFECYCLE_REPLAY_FIXTURE_VERSION = 1 as const;

export type LifecycleRecoveryAction =
  | "claim_lease"
  | "prepare_workspace"
  | "start_worker"
  | "reconcile_worker_result"
  | "verify_candidate"
  | "promote_candidate"
  | "prove_reachability"
  | "reconcile_reachability"
  | "reconcile_authority"
  | "record_pending_or_close"
  | "cleanup_workspace"
  | "release_lease"
  | "contained"
  | "complete";

export interface ObservedLifecycleFacts {
  leaseOwned?: boolean;
  workspaceExists?: boolean;
  candidateReachable?: boolean;
  authorityOpen?: boolean;
  pendingVerificationRecorded?: boolean;
  contained?: boolean;
}

export interface LifecycleReplayPlan {
  nextAction: LifecycleRecoveryAction;
  reason: string;
  mustNotRepeat: string[];
  state: LifecycleJournalState;
}

export interface LifecycleReplayFixtureEvent {
  event: LifecycleJournalAppendInput["event"];
  at?: string;
  idempotencyKey?: string;
  payload?: LifecycleJournalAppendInput["payload"];
}

export interface LifecycleReplayExpectation {
  nextAction: LifecycleRecoveryAction;
  mustNotRepeat?: string[];
}

export interface LifecycleReplayFixture {
  version: typeof LIFECYCLE_REPLAY_FIXTURE_VERSION;
  name: string;
  runId: string;
  issueNumber: number;
  events: LifecycleReplayFixtureEvent[];
  observed: ObservedLifecycleFacts;
  expect: LifecycleReplayExpectation;
}

export interface LifecycleReplaySuite {
  version: typeof LIFECYCLE_REPLAY_FIXTURE_VERSION;
  cases: LifecycleReplayFixture[];
}

export interface LifecycleReplayResult {
  name: string;
  ok: boolean;
  plan: LifecycleReplayPlan;
  expected: LifecycleReplayExpectation;
  error?: string;
}

function fixtureRecords(fixture: LifecycleReplayFixture): LifecycleJournalRecord[] {
  return fixture.events.map((event, index) => ({
    version: LIFECYCLE_JOURNAL_VERSION,
    sequence: index + 1,
    at: event.at ?? new Date(Date.UTC(2026, 7, 22, 12, 0, index)).toISOString(),
    runId: fixture.runId,
    issueNumber: fixture.issueNumber,
    event: event.event,
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    payload: structuredClone(event.payload ?? {}),
  }));
}

function priorActions(state: LifecycleJournalState, facts: ObservedLifecycleFacts): string[] {
  const completed: string[] = [];
  if (state.leaseOwned || state.leaseReleased || facts.leaseOwned !== undefined) completed.push("claim_lease");
  if (state.workspacePrepared || facts.workspaceExists) completed.push("prepare_workspace");
  if (state.workerStarted) completed.push("start_worker");
  if (state.workerFinished) completed.push("run_worker");
  if (state.verification !== undefined) completed.push("verify_candidate");
  if (state.mergeSha || state.reachabilityProven || facts.candidateReachable) completed.push("promote_candidate");
  if (state.reachabilityProven || facts.candidateReachable) completed.push("prove_reachability");
  if (state.authorityReconciled) completed.push("reconcile_authority");
  if (state.pendingVerification || state.issueClosed || facts.pendingVerificationRecorded || facts.authorityOpen === false) {
    completed.push("record_pending_or_close");
  }
  if (state.workspaceCleaned) completed.push("cleanup_workspace");
  if (state.leaseReleased) completed.push("release_lease");
  return [...new Set(completed)];
}

/**
 * Deterministic recovery planner. It never performs promotion/closure/cleanup
 * itself; replay combines durable journal state with externally observed Git
 * and authority facts and decides the next safe production transition.
 */
export function planLifecycleRecovery(
  records: readonly LifecycleJournalRecord[],
  facts: ObservedLifecycleFacts = {},
): LifecycleReplayPlan {
  const state = materializeLifecycleJournal(records);
  const mustNotRepeat = priorActions(state, facts);

  if (facts.contained || state.lastFailure?.scope === "issue-local") {
    return {
      nextAction: "contained",
      reason: "typed issue-local failure is already contained; do not replay unsafe mutation",
      mustNotRepeat,
      state,
    };
  }

  const authoritySettled =
    state.issueClosed ||
    state.pendingVerification ||
    facts.pendingVerificationRecorded === true ||
    facts.authorityOpen === false;

  if (authoritySettled) {
    if (!state.workspaceCleaned && facts.workspaceExists !== false) {
      return {
        nextAction: "cleanup_workspace",
        reason: "authority disposition is durable; cleanup remains",
        mustNotRepeat,
        state,
      };
    }
    if (!state.leaseReleased && (state.leaseOwned || facts.leaseOwned)) {
      return {
        nextAction: "release_lease",
        reason: "terminal authority disposition is durable and only lease release remains",
        mustNotRepeat,
        state,
      };
    }
    return {
      nextAction: "complete",
      reason: "terminal disposition and safe cleanup/release facts are already durable",
      mustNotRepeat,
      state,
    };
  }

  const reachable = state.reachabilityProven || facts.candidateReachable === true;
  if (reachable) {
    if (!state.reachabilityProven && facts.candidateReachable) {
      return {
        nextAction: "reconcile_reachability",
        reason: "Git proves candidate reachable after a crash; record proof instead of pushing again",
        mustNotRepeat,
        state,
      };
    }
    if (!state.authorityReconciled) {
      return {
        nextAction: "reconcile_authority",
        reason: "candidate is durably reachable; refresh live authority before terminal disposition",
        mustNotRepeat,
        state,
      };
    }
    return {
      nextAction: "record_pending_or_close",
      reason: "reachability and authority reconciliation are durable; apply the verified terminal policy",
      mustNotRepeat,
      state,
    };
  }

  if (state.mergeSha) {
    return {
      nextAction: "prove_reachability",
      reason: "promotion was recorded but reachability proof is absent",
      mustNotRepeat,
      state,
    };
  }

  if (state.candidateSha && state.verification === "pass") {
    return {
      nextAction: "promote_candidate",
      reason: "verified candidate exists but promotion has not completed",
      mustNotRepeat,
      state,
    };
  }

  if (state.workerFinished && state.verification === undefined) {
    return {
      nextAction: "verify_candidate",
      reason: "worker completed but no final verification outcome is durable",
      mustNotRepeat,
      state,
    };
  }

  if (state.workerStarted && !state.workerFinished) {
    return {
      nextAction: "reconcile_worker_result",
      reason: "worker start is durable but terminal result is missing; inspect durable evidence before retry",
      mustNotRepeat,
      state,
    };
  }

  const leaseOwned = state.leaseOwned || facts.leaseOwned === true;
  if (leaseOwned && !(state.workspacePrepared || facts.workspaceExists)) {
    return {
      nextAction: "prepare_workspace",
      reason: "lease is owned but canonical workspace preparation is not durable",
      mustNotRepeat,
      state,
    };
  }

  if (leaseOwned) {
    return {
      nextAction: "start_worker",
      reason: "owned canonical work is ready and no worker attempt is durable",
      mustNotRepeat,
      state,
    };
  }

  return {
    nextAction: "claim_lease",
    reason: "no authoritative ownership is durable",
    mustNotRepeat,
    state,
  };
}

function validateFixture(value: unknown): LifecycleReplayFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("replay fixture must be an object");
  const fixture = value as Partial<LifecycleReplayFixture>;
  if (fixture.version !== LIFECYCLE_REPLAY_FIXTURE_VERSION) {
    throw new Error(`unsupported replay fixture version ${String(fixture.version)}`);
  }
  if (!fixture.name?.trim() || !fixture.runId?.trim()) throw new Error("replay fixture requires name and runId");
  if (!Number.isSafeInteger(fixture.issueNumber) || (fixture.issueNumber ?? 0) < 1) throw new Error("replay fixture requires a positive issueNumber");
  if (!Array.isArray(fixture.events)) throw new Error("replay fixture requires events[]");
  if (!fixture.observed || typeof fixture.observed !== "object") throw new Error("replay fixture requires observed facts");
  if (!fixture.expect?.nextAction) throw new Error("replay fixture requires expect.nextAction");
  return structuredClone(fixture) as LifecycleReplayFixture;
}

export function evaluateLifecycleReplayFixture(fixtureInput: unknown): LifecycleReplayResult {
  const fixture = validateFixture(fixtureInput);
  const plan = planLifecycleRecovery(fixtureRecords(fixture), fixture.observed);
  const missingMustNotRepeat = (fixture.expect.mustNotRepeat ?? []).filter(
    (action) => !plan.mustNotRepeat.includes(action),
  );
  const ok = plan.nextAction === fixture.expect.nextAction && missingMustNotRepeat.length === 0;
  return {
    name: fixture.name,
    ok,
    plan,
    expected: fixture.expect,
    ...(ok
      ? {}
      : {
          error: [
            plan.nextAction !== fixture.expect.nextAction
              ? `expected nextAction=${fixture.expect.nextAction}, got ${plan.nextAction}`
              : "",
            missingMustNotRepeat.length
              ? `missing mustNotRepeat=${missingMustNotRepeat.join(",")}`
              : "",
          ].filter(Boolean).join("; "),
        }),
  };
}

export function loadLifecycleReplaySuite(path: string): LifecycleReplaySuite {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("replay suite must be an object");
  const suite = parsed as Partial<LifecycleReplaySuite>;
  if (suite.version !== LIFECYCLE_REPLAY_FIXTURE_VERSION) {
    throw new Error(`unsupported replay suite version ${String(suite.version)}`);
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error("replay suite requires cases[]");
  return {
    version: LIFECYCLE_REPLAY_FIXTURE_VERSION,
    cases: suite.cases.map(validateFixture),
  };
}

export function evaluateLifecycleReplaySuite(path: string): LifecycleReplayResult[] {
  return loadLifecycleReplaySuite(path).cases.map(evaluateLifecycleReplayFixture);
}

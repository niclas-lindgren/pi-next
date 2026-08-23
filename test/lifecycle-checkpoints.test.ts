import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  emitLifecycleCheckpoint,
  lifecycleFaultInjectionFromEnv,
  LifecycleCheckpointFault,
  RECOVERY_LIFECYCLE_CHECKPOINT_COVERAGE,
  RECOVERY_LIFECYCLE_CHECKPOINTS,
  type RecoveryLifecycleCheckpoint,
  withLifecycleFaultInjection,
} from "../src/coordination/lifecycle-checkpoints.ts";
import {
  appendLifecycleJournal,
  LIFECYCLE_JOURNAL_EVENTS,
  materializeLifecycleJournal,
  readLifecycleJournal,
  type LifecycleJournalEventName,
} from "../src/coordination/lifecycle-journal.ts";

const JOURNAL_BACKED_CHECKPOINTS: readonly RecoveryLifecycleCheckpoint[] = RECOVERY_LIFECYCLE_CHECKPOINTS.filter(
  (checkpoint): checkpoint is RecoveryLifecycleCheckpoint =>
    (LIFECYCLE_JOURNAL_EVENTS as readonly string[]).includes(checkpoint),
);

test("recovery lifecycle checkpoints are stable, typed, and journal-covered where durable", () => {
  assert.deepEqual(RECOVERY_LIFECYCLE_CHECKPOINTS, [
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
  ]);

  assert.deepEqual(Object.keys(RECOVERY_LIFECYCLE_CHECKPOINT_COVERAGE), [...RECOVERY_LIFECYCLE_CHECKPOINTS]);
  for (const checkpoint of RECOVERY_LIFECYCLE_CHECKPOINTS) {
    const coverage = RECOVERY_LIFECYCLE_CHECKPOINT_COVERAGE[checkpoint];
    assert.equal(coverage.durableJournalEvent, true, `${checkpoint} must declare durable journal coverage`);
    assert.ok(coverage.description.length > 20, `${checkpoint} must document its lifecycle boundary`);
    assert.ok(coverage.invariant.length > 20, `${checkpoint} must document its crash/restart invariant`);
  }

  const nonBoundaryJournalEvents = new Set([
    "baseline_imported",
    "lease_rejected",
    "lease_taken_over",
    "failure_recorded",
  ]);
  for (const event of LIFECYCLE_JOURNAL_EVENTS) {
    if (!nonBoundaryJournalEvents.has(event)) {
      assert.ok(
        (RECOVERY_LIFECYCLE_CHECKPOINTS as readonly string[]).includes(event),
        `journal event ${event} must either be a recovery checkpoint or be explicitly classified non-boundary`,
      );
    }
  }
});

test("fault injection is disabled unless explicitly configured and reports checkpoint + position", async () => {
  assert.equal(lifecycleFaultInjectionFromEnv({ PI_NEXT_LIFECYCLE_FAULT_AT: "lease_claimed:before" }), undefined);
  assert.deepEqual(
    lifecycleFaultInjectionFromEnv({
      PI_NEXT_ENABLE_LIFECYCLE_FAULT_INJECTION: "1",
      PI_NEXT_LIFECYCLE_FAULT_AT: "lease_claimed:before:throw",
    }),
    { checkpoint: "lease_claimed", position: "before", action: "throw" },
  );
  emitLifecycleCheckpoint("lease_claimed", "before");

  await assert.rejects(
    withLifecycleFaultInjection({ checkpoint: "lease_claimed", position: "after" }, async () => {
      emitLifecycleCheckpoint("lease_claimed", "before");
      emitLifecycleCheckpoint("lease_claimed", "after");
    }),
    (error: unknown) => {
      assert.ok(error instanceof LifecycleCheckpointFault);
      assert.equal(error.checkpoint, "lease_claimed");
      assert.equal(error.position, "after");
      assert.match(error.message, /lease_claimed \(after\)/);
      return true;
    },
  );
});

type EffectName =
  | "owners"
  | "workspaces"
  | "authorityReads"
  | "plans"
  | "implementationWorkers"
  | "verificationRuns"
  | "commits"
  | "promotions"
  | "pushes"
  | "reachabilityProofs"
  | "authorityReconciliations"
  | "closes"
  | "leaseReleases"
  | "cleanups";

type Effects = Record<EffectName, number>;

const emptyEffects = (): Effects => ({
  owners: 0,
  workspaces: 0,
  authorityReads: 0,
  plans: 0,
  implementationWorkers: 0,
  verificationRuns: 0,
  commits: 0,
  promotions: 0,
  pushes: 0,
  reachabilityProofs: 0,
  authorityReconciliations: 0,
  closes: 0,
  leaseReleases: 0,
  cleanups: 0,
});

const transitionEffects: Record<RecoveryLifecycleCheckpoint, readonly EffectName[]> = {
  candidate_selected: [],
  lease_claimed: ["owners"],
  workspace_prepared: ["workspaces"],
  authority_loaded: ["authorityReads"],
  plan_ready: ["plans"],
  worker_started: ["implementationWorkers"],
  worker_finished: [],
  verification_finished: ["verificationRuns"],
  candidate_committed: ["commits"],
  candidate_pushed: ["pushes"],
  promotion_started: ["promotions"],
  promotion_pushed: ["pushes"],
  promotion_succeeded: [],
  reachability_proven: ["reachabilityProofs"],
  authority_reconciled: ["authorityReconciliations"],
  pending_verification_recorded: [],
  issue_closed: ["closes"],
  lease_released: ["leaseReleases"],
  workspace_cleaned: ["cleanups"],
};

function payloadFor(checkpoint: RecoveryLifecycleCheckpoint) {
  switch (checkpoint) {
    case "candidate_selected": return { workItemId: "78" };
    case "lease_claimed": return { agent: "pi-next", branch: "agent/issue-78", worktree: ".worktrees/issue-78" };
    case "verification_finished": return { verification: "pass" as const, candidateSha: "a".repeat(40) };
    case "candidate_committed": return { candidateSha: "a".repeat(40) };
    case "candidate_pushed": return { branch: "agent/issue-78", candidateSha: "a".repeat(40) };
    case "promotion_pushed": return { candidateSha: "a".repeat(40), mainSha: "b".repeat(40) };
    case "promotion_succeeded": return { mergeSha: "b".repeat(40) };
    case "reachability_proven": return { candidateSha: "a".repeat(40), mainSha: "b".repeat(40) };
    default: return {};
  }
}

async function runRecoverableLifecycle(file: string, effects: Effects): Promise<void> {
  const records = readLifecycleJournal(file);
  const completed = new Set(records.map((record) => record.event));
  for (const checkpoint of RECOVERY_LIFECYCLE_CHECKPOINTS) {
    if (completed.has(checkpoint as LifecycleJournalEventName)) continue;
    emitLifecycleCheckpoint(checkpoint, "before");
    for (const effect of transitionEffects[checkpoint]) effects[effect] += 1;
    if (JOURNAL_BACKED_CHECKPOINTS.includes(checkpoint)) {
      appendLifecycleJournal(file, {
        runId: "fault-matrix-run",
        issueNumber: 78,
        event: checkpoint as LifecycleJournalEventName,
        idempotencyKey: `transition:${checkpoint}`,
        payload: payloadFor(checkpoint),
      });
    }
    emitLifecycleCheckpoint(checkpoint, "after");
  }
}

test("crash/restart matrix is idempotent across every recovery checkpoint", async () => {
  for (const checkpoint of RECOVERY_LIFECYCLE_CHECKPOINTS) {
    for (const position of ["before", "after"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-next-fault-${checkpoint}-${position}-`));
      const file = join(root, "journal", "run.jsonl");
      const effects = emptyEffects();
      try {
        await assert.rejects(
          withLifecycleFaultInjection({ checkpoint, position }, () => runRecoverableLifecycle(file, effects)),
          (error: unknown) => error instanceof LifecycleCheckpointFault
            && error.checkpoint === checkpoint
            && error.position === position,
        );

        await runRecoverableLifecycle(file, effects);
        const state = materializeLifecycleJournal(readLifecycleJournal(file));

        assert.ok(effects.owners <= 1, `${checkpoint}/${position}: no duplicate owner/claim`);
        assert.ok(effects.implementationWorkers <= 1, `${checkpoint}/${position}: no duplicate implementation worker`);
        assert.ok(effects.commits <= 1, `${checkpoint}/${position}: no duplicate candidate commit`);
        assert.ok(effects.promotions <= 1, `${checkpoint}/${position}: no duplicate promotion start`);
        assert.ok(effects.pushes <= 2, `${checkpoint}/${position}: no duplicate candidate or promotion push`);
        assert.ok(effects.closes === 0 || state.authorityReconciled, `${checkpoint}/${position}: no close before authority proof`);
        assert.ok(effects.cleanups === 0 || state.reachabilityProven, `${checkpoint}/${position}: cleanup waits for reachability`);
        assert.equal(state.pendingVerification, true, `${checkpoint}/${position}: pending verification remains durable`);
        assert.equal(state.workspaceCleaned, true, `${checkpoint}/${position}: lifecycle can resume through cleanup`);
        assert.ok(effects.leaseReleases <= 1, `${checkpoint}/${position}: lease release is idempotent`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

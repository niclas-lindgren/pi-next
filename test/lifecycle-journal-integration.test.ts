import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LifecycleCheckpointFault,
  withLifecycleFaultInjection,
} from "../src/coordination/lifecycle-checkpoints.ts";
import { readLifecycleJournal } from "../src/coordination/lifecycle-journal.ts";
import { recordLifecycleEvent } from "../extensions/pi-next/lifecycle-telemetry.ts";
import {
  piLifecycleJournalFile,
  recordPiLifecycleJournal,
} from "../extensions/pi-next/lifecycle-journal.ts";
import {
  issueWorkerRunnerFromAdapter,
  PiWorkerAdapter,
} from "../extensions/pi-next/pi-worker-adapter.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-next-journal-integration-"));
}

test("legacy rolling lifecycle telemetry seeds baseline and mirrors recovery facts", async () => {
  const root = await tempRoot();
  try {
    const runId = "journal-legacy-bridge";
    recordLifecycleEvent(root, {
      event: "claim_acquired",
      issueNumber: 710,
      runId,
      agent: "pi-next",
      branch: "agent/issue-710",
      worktree: ".worktrees/issue-710",
      outcome: "success",
      at: "2026-08-22T12:00:00.000Z",
    });
    const records = readLifecycleJournal(piLifecycleJournalFile(root, runId));
    assert.deepEqual(records.map((record) => record.event), ["baseline_imported", "lease_claimed"]);
    assert.equal(records[0].payload.source, "pi-next-lifecycle-v1");
    assert.equal(records[1].payload.branch, "agent/issue-710");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker adapter bridge journals boundaries without prompt or raw output", async () => {
  const root = await tempRoot();
  try {
    const runId = "journal-worker-bridge";
    const adapter = new PiWorkerAdapter(async () => ({
      ok: true,
      output: "RAW_OUTPUT_DO_NOT_PERSIST",
      code: 0,
      signal: null,
      telemetry: { status: "complete" },
    }));
    const worker = issueWorkerRunnerFromAdapter(adapter);
    const result = await worker(root, "PROMPT_DO_NOT_PERSIST", {
      issueNumber: 711,
      runId,
      phase: "implementation",
      coordinationCwd: root,
    });
    assert.equal(result.ok, true);
    const file = piLifecycleJournalFile(root, runId);
    const records = readLifecycleJournal(file);
    assert.deepEqual(records.map((record) => record.event), ["worker_started", "worker_finished"]);
    assert.equal(records[0].payload.adapterId, "pi");
    assert.equal(records[1].payload.ok, true);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes("PROMPT_DO_NOT_PERSIST"), false);
    assert.equal(raw.includes("RAW_OUTPUT_DO_NOT_PERSIST"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi journal bridge exposes deterministic before/after lifecycle faults", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "lease_claimed", position: "after" }, () => {
        recordPiLifecycleJournal(root, {
          runId: "journal-fault-bridge",
          issueNumber: 713,
          event: "lease_claimed",
          payload: { branch: "agent/issue-713", worktree: ".worktrees/issue-713" },
        });
      }),
      (error: unknown) => error instanceof LifecycleCheckpointFault
        && error.checkpoint === "lease_claimed"
        && error.position === "after",
    );
    assert.deepEqual(
      readLifecycleJournal(piLifecycleJournalFile(root, "journal-fault-bridge")).map((record) => record.event),
      ["lease_claimed"],
    );

    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "workspace_prepared", position: "before" }, () => {
        recordPiLifecycleJournal(root, {
          runId: "journal-fault-before",
          issueNumber: 714,
          event: "workspace_prepared",
          payload: { worktree: ".worktrees/issue-714" },
        });
      }),
      (error: unknown) => error instanceof LifecycleCheckpointFault
        && error.checkpoint === "workspace_prepared"
        && error.position === "before",
    );
    assert.deepEqual(readLifecycleJournal(piLifecycleJournalFile(root, "journal-fault-before")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed worker settlement adds a bounded typed failure without raw output", async () => {
  const root = await tempRoot();
  try {
    const runId = "journal-worker-failure";
    const adapter = new PiWorkerAdapter(async () => ({
      ok: false,
      output: "FAILURE_OUTPUT_DO_NOT_PERSIST",
      code: 9,
      signal: null,
      telemetry: { status: "complete" },
      failure: {
        code: "fixture_failure",
        summary: "fixture failed",
        diagnosticExcerpt: "private diagnostic should remain outside journal",
      },
    } as never));
    const worker = issueWorkerRunnerFromAdapter(adapter);
    const result = await worker(root, "FAILURE_PROMPT_DO_NOT_PERSIST", {
      issueNumber: 712,
      runId,
      phase: "implementation",
      coordinationCwd: root,
    });
    assert.equal(result.ok, false);
    const file = piLifecycleJournalFile(root, runId);
    const records = readLifecycleJournal(file);
    assert.deepEqual(records.map((record) => record.event), ["worker_started", "worker_finished", "failure_recorded"]);
    assert.equal(records[2].payload.reasonCode, "fixture_failure");
    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes("FAILURE_OUTPUT_DO_NOT_PERSIST"), false);
    assert.equal(raw.includes("private diagnostic"), false);
    assert.equal(raw.includes("FAILURE_PROMPT_DO_NOT_PERSIST"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

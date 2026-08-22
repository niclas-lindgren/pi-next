import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendLifecycleJournal,
  LifecycleJournalError,
  materializeLifecycleJournal,
  readLifecycleJournal,
  type LifecycleJournalPayload,
} from "../src/coordination/lifecycle-journal.ts";

async function withTempJournal(run: (file: string) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-next-journal-"));
  try {
    await run(join(root, "journal", "run.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("append-only journal assigns monotonic sequence and materializes recovery state", async () => {
  await withTempJournal((file) => {
    appendLifecycleJournal(file, {
      runId: "run-1",
      issueNumber: 77,
      event: "lease_claimed",
      at: "2026-08-22T12:00:00.000Z",
      payload: { agent: "pi-next", branch: "agent/issue-77", worktree: ".worktrees/issue-77" },
    });
    appendLifecycleJournal(file, {
      runId: "run-1",
      issueNumber: 77,
      event: "worker_started",
      at: "2026-08-22T12:00:01.000Z",
      payload: { adapterId: "scripted", adapterVersion: "1", phase: "implementation" },
    });
    appendLifecycleJournal(file, {
      runId: "run-1",
      issueNumber: 77,
      event: "worker_finished",
      at: "2026-08-22T12:00:02.000Z",
      payload: { adapterId: "scripted", adapterVersion: "1", ok: true, code: 0 },
    });
    appendLifecycleJournal(file, {
      runId: "run-1",
      issueNumber: 77,
      event: "verification_finished",
      at: "2026-08-22T12:00:03.000Z",
      payload: { verification: "pass", candidateSha: "a".repeat(40) },
    });
    const records = readLifecycleJournal(file);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4]);
    const state = materializeLifecycleJournal(records);
    assert.equal(state.runId, "run-1");
    assert.equal(state.issueNumber, 77);
    assert.equal(state.leaseOwned, true);
    assert.equal(state.workerStarted, true);
    assert.equal(state.workerFinished, true);
    assert.equal(state.verification, "pass");
    assert.equal(state.candidateSha, "a".repeat(40));
  });
});

test("idempotency key returns the durable record without appending a duplicate", async () => {
  await withTempJournal((file) => {
    const first = appendLifecycleJournal(file, {
      runId: "run-idempotent",
      issueNumber: 77,
      event: "reachability_proven",
      idempotencyKey: "reachability:candidate-a:main-b",
      payload: { candidateSha: "a".repeat(40), mainSha: "b".repeat(40) },
    });
    const second = appendLifecycleJournal(file, {
      runId: "run-idempotent",
      issueNumber: 77,
      event: "reachability_proven",
      idempotencyKey: "reachability:candidate-a:main-b",
      payload: { candidateSha: "a".repeat(40), mainSha: "b".repeat(40) },
    });
    assert.equal(second.sequence, first.sequence);
    assert.equal(readLifecycleJournal(file).length, 1);
  });
});

test("journal refuses secret/transcript-style payload fields", async () => {
  await withTempJournal((file) => {
    assert.throws(
      () => appendLifecycleJournal(file, {
        runId: "run-secret",
        event: "failure_recorded",
        payload: { prompt: "do not persist me" } as unknown as LifecycleJournalPayload,
      }),
      (error: unknown) => error instanceof LifecycleJournalError && error.code === "INVALID_RECORD",
    );
    assert.deepEqual(readLifecycleJournal(file), []);
  });
});

test("corrupt JSON and unsupported versions fail clearly instead of being guessed through", async () => {
  await withTempJournal(async (file) => {
    await writeFile(file, "{not-json}\n", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "{not-json}\n", "utf8");
    });
    assert.throws(
      () => readLifecycleJournal(file),
      (error: unknown) => error instanceof LifecycleJournalError && error.code === "JOURNAL_CORRUPT",
    );
  });

  await withTempJournal(async (file) => {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      version: 99,
      sequence: 1,
      at: "2026-08-22T12:00:00.000Z",
      runId: "run-version",
      event: "lease_claimed",
      payload: {},
    })}\n`, "utf8");
    assert.throws(
      () => readLifecycleJournal(file),
      (error: unknown) => error instanceof LifecycleJournalError && error.code === "UNSUPPORTED_VERSION",
    );
  });
});

test("journal rejects cross-run append and non-monotonic persisted sequence", async () => {
  await withTempJournal(async (file) => {
    appendLifecycleJournal(file, { runId: "run-a", event: "candidate_selected", payload: { workItemId: "77" } });
    assert.throws(
      () => appendLifecycleJournal(file, { runId: "run-b", event: "candidate_selected", payload: { workItemId: "77" } }),
      (error: unknown) => error instanceof LifecycleJournalError && error.code === "RUN_MISMATCH",
    );
  });

  await withTempJournal(async (file) => {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      version: 1,
      sequence: 2,
      at: "2026-08-22T12:00:00.000Z",
      runId: "run-sequence",
      event: "candidate_selected",
      payload: { workItemId: "77" },
    })}\n`, "utf8");
    assert.throws(
      () => readLifecycleJournal(file),
      (error: unknown) => error instanceof LifecycleJournalError && error.code === "JOURNAL_CORRUPT",
    );
  });
});

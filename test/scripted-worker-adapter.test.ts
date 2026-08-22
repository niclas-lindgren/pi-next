import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkerEvent } from "../src/coordination/worker-adapter.ts";
import {
  MAX_SCRIPTED_WORKER_EVENTS,
  ScriptedWorkerAdapter,
  ScriptedWorkerBindingError,
} from "../src/evaluation/scripted-worker-adapter.ts";
import { createDisposableGitFixture } from "./helpers/git-fixture.ts";

const task = (cwd: string) => ({
  cwd,
  prompt: "deterministic fixture task",
  issueNumber: 76,
  runId: "scenario-run",
  phase: "implementation",
});

test("scripted worker performs bounded writes and commits without Pi", async () => {
  const git = await createDisposableGitFixture({ prefix: "scripted-worker-" });
  try {
    const adapter = new ScriptedWorkerAdapter([{
      name: "write-and-commit",
      expect: { cwd: git.repo, issueNumber: 76, runId: "scenario-run", phase: "implementation" },
      writes: [{ path: "src/change.txt", content: "candidate\n" }],
      commit: { message: "test: scripted candidate" },
    }]);
    const before = await git.revision();
    const result = await adapter.run(task(git.repo), new AbortController().signal);
    const after = await git.revision();

    assert.equal(result.ok, true);
    assert.notEqual(after, before);
    assert.equal(adapter.invocations.length, 1);
    assert.equal(adapter.remaining, 0);
  } finally {
    await git.cleanup();
  }
});

test("scripted worker exposes bounded provider-neutral event sequences", async () => {
  const git = await createDisposableGitFixture({ prefix: "scripted-events-", withOrigin: false });
  try {
    const events: WorkerEvent[] = [
      { type: "activity", phase: "implementation", kind: "read", summary: "read fixture" },
      {
        type: "runtime",
        startedAt: "2026-08-22T12:00:00.000Z",
        lastActivityAt: "2026-08-22T12:00:01.000Z",
        alive: true,
      },
      {
        type: "watchdog",
        kind: "suspected_stall",
        wallClockMs: 2_000,
        idleMs: 1_000,
        reason: "fixture soft stall",
      },
    ];
    const observed: WorkerEvent[] = [];
    const adapter = new ScriptedWorkerAdapter([{ events }]);
    await adapter.run(task(git.repo), new AbortController().signal, (event) => observed.push(event));
    assert.deepEqual(observed, events);

    const overflow = new ScriptedWorkerAdapter([{
      events: Array.from({ length: MAX_SCRIPTED_WORKER_EVENTS + 1 }, (_, index) => ({
        type: "activity" as const,
        kind: "tool",
        summary: `event-${index}`,
      })),
    }]);
    await assert.rejects(
      overflow.run(task(git.repo), new AbortController().signal),
      /event budget exceeded/,
    );
  } finally {
    await git.cleanup();
  }
});

test("scripted worker models failure, blocked, timeout and malformed terminal results", async () => {
  const git = await createDisposableGitFixture({ prefix: "scripted-results-", withOrigin: false });
  try {
    const adapter = new ScriptedWorkerAdapter([
      { behavior: "failure", output: `${"x".repeat(2_000)}\nERROR fixture failed` },
      { behavior: "blocked", output: "authority unavailable" },
      { behavior: "timeout", output: "worker timed out" },
      { behavior: "malformed", malformedResult: { nope: true } },
    ]);
    const signal = new AbortController().signal;
    const failed = await adapter.run(task(git.repo), signal);
    const blocked = await adapter.run(task(git.repo), signal);
    const timeout = await adapter.run(task(git.repo), signal);
    const malformed = await adapter.run(task(git.repo), signal) as unknown as Record<string, unknown>;

    assert.equal(failed.ok, false);
    assert.equal(failed.code, 1);
    assert.ok((failed.failure?.diagnosticExcerpt.length ?? 0) <= 1_000);
    assert.equal(blocked.failure?.code, "scripted_worker_blocked");
    assert.equal(timeout.signal, "SIGTERM");
    assert.equal(timeout.telemetry.status, "partial");
    assert.deepEqual(malformed, { nope: true });
  } finally {
    await git.cleanup();
  }
});

test("scripted worker cancellation is deterministic and abort-driven", async () => {
  const git = await createDisposableGitFixture({ prefix: "scripted-cancel-", withOrigin: false });
  try {
    const controller = new AbortController();
    const adapter = new ScriptedWorkerAdapter([{ behavior: "wait-for-cancel" }]);
    const pending = adapter.run(task(git.repo), controller.signal);
    controller.abort("fixture cancellation");
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.failure?.code, "scripted_worker_cancelled");
  } finally {
    await git.cleanup();
  }
});

test("scripted worker rejects stale or wrong controller binding before mutation", async () => {
  const git = await createDisposableGitFixture({ prefix: "scripted-binding-", withOrigin: false });
  try {
    const adapter = new ScriptedWorkerAdapter([{
      expect: { issueNumber: 999 },
      writes: [{ path: "must-not-exist.txt", content: "unsafe\n" }],
    }]);
    await assert.rejects(
      adapter.run(task(git.repo), new AbortController().signal),
      (error: unknown) => error instanceof ScriptedWorkerBindingError,
    );
    assert.equal(await git.git(git.repo, "status", "--porcelain"), "");
  } finally {
    await git.cleanup();
  }
});

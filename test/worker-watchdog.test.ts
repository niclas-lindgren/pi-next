import assert from "node:assert/strict";
import { test } from "node:test";

import { runIssueWorker, type WorkerWatchdogEvent } from "../extensions/pi-next/util-core.ts";

test("worker watchdog distinguishes a silent process and terminates it within grace", async () => {
  const events: WorkerWatchdogEvent[] = [];
  const result = await runIssueWorker("/tmp", "watchdog test", {
    executable: "/bin/sh",
    executableArgs: ["-c", "sleep 10"],
    issueNumber: 59,
    runId: "watchdog-test",
    phase: "implementation",
    watchdog: { softIdleMs: 20, hardIdleMs: 80, hardWallMs: 5_000, terminationGraceMs: 20 },
    onWatchdog: (event) => events.push(event),
  });
  assert.equal(result.ok, false);
  assert.equal(result.watchdog?.kind, "worker_timeout");
  assert.ok(events.some((event) => event.kind === "suspected_stall"));
  assert.ok(events.some((event) => event.kind === "worker_timeout"));
  assert.equal(result.watchdog?.issueNumber, 59);
});

test("worker watchdog does not classify an explicit abort as a timeout", async () => {
  const controller = new AbortController();
  const task = runIssueWorker("/tmp", "abort test", {
    executable: "/bin/sh",
    executableArgs: ["-c", "sleep 10"],
    signal: controller.signal,
    watchdog: { softIdleMs: 500, hardIdleMs: 2_000, hardWallMs: 5_000, terminationGraceMs: 20 },
  });
  setTimeout(() => controller.abort(), 30).unref();
  const result = await task;
  assert.equal(result.watchdog, undefined);
});

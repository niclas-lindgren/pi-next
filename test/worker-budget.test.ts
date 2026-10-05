import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorker, type WorkerFactory, type WorkerSession } from "../scripts/bootstrap-self-host.ts";

function workerFactory(stats: ReturnType<NonNullable<WorkerSession["getSessionStats"]>>): WorkerFactory {
  return async () => {
    let listener: ((event: unknown) => void) | undefined;
    return {
      model: { provider: "fake", id: "cache-heavy" },
      subscribe(next) {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
      async prompt() {
        listener?.({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
      },
      async abort() {},
      dispose() {},
      getSessionStats: () => stats,
    };
  };
}

test("cache reads do not consume the bootstrap worker token budget", async () => {
  const reports = [];
  const report = await runWorker(
    workerFactory({
      toolCalls: 3,
      tokens: {
        input: 19_872,
        output: 181,
        cacheRead: 34_688,
        cacheWrite: 0,
        total: 54_741,
      },
      cost: 0.004,
    }),
    "implementation",
    "implement the task",
    process.cwd(),
    1_000,
    reports,
    175,
    undefined,
    0,
  );

  assert.equal(report.disposition, "completed");
  assert.equal(report.usage?.total, 54_741);
  assert.equal(report.usage?.cacheRead, 34_688);
  assert.equal(report.telemetryWarning, "worker token warning: 20053 fresh tokens reached warning threshold 20000");
});

test("fresh input plus output still enforces the hard worker token budget", async () => {
  const reports = [];
  const report = await runWorker(
    workerFactory({
      toolCalls: 1,
      tokens: {
        input: 50_000,
        output: 1,
        cacheRead: 100_000,
        cacheWrite: 0,
        total: 150_001,
      },
      cost: 0.01,
    }),
    "implementation",
    "implement the task",
    process.cwd(),
    1_000,
    reports,
    176,
    undefined,
    0,
  );

  assert.equal(report.disposition, "cancelled");
  assert.match(report.reason ?? "", /50001 fresh tokens reached hard threshold 50000/);
  assert.equal(report.usage?.cacheRead, 100_000);
});

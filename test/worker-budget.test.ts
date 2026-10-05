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

test("token telemetry does not terminate bootstrap workers by default", async () => {
  const reports = [];
  const report = await runWorker(
    workerFactory({
      toolCalls: 3,
      tokens: {
        input: 50_000,
        output: 1_000,
        cacheRead: 100_000,
        cacheWrite: 0,
        total: 151_000,
      },
      cost: 0.01,
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
  assert.equal(report.usage?.total, 151_000);
  assert.equal(report.usage?.cacheRead, 100_000);
  assert.equal(report.telemetryWarning, undefined);
});

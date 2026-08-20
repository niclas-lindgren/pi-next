import assert from "node:assert/strict";
import { test } from "node:test";

import { appendWorkerNarrative } from "../extensions/pi-next/work-log.ts";
import type { WorkerWorkLogEvent } from "../extensions/pi-next/worker-activity.ts";

function event(kind: WorkerWorkLogEvent["kind"]): WorkerWorkLogEvent {
  return { issueNumber: 42, runId: "run", phase: "implementation", kind, summary: kind };
}

test("auto-loop narrative sink keeps semantic summaries and filters mechanical activity", () => {
  const entries: unknown[][] = [];
  const pi = { appendEntry: (...args: unknown[]) => entries.push(args) };
  appendWorkerNarrative(pi as never, event("read"));
  appendWorkerNarrative(pi as never, event("search"));
  appendWorkerNarrative(pi as never, event("edit"));
  appendWorkerNarrative(pi as never, event("tool"));
  assert.equal(entries.length, 0);

  appendWorkerNarrative(pi as never, event("assistant"));
  appendWorkerNarrative(pi as never, event("verify"));
  appendWorkerNarrative(pi as never, event("error"));
  assert.equal(entries.length, 3);
});

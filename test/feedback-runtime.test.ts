import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { feedbackFile, reportRuntimeFailure, resetRuntimeFeedback } from "../extensions/pi-next/feedback-runtime.ts";

test("typed runtime failures reach the configured local sink once and remain bounded", async () => {
  const cwd = join(tmpdir(), `pi-next-feedback-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const input = { stage: "claim", category: "integrity" as const, severity: "fatal" as const, outcome: "failed" as const, code: "lease_conflict", summary: "token=secret-value /home/alice/private", issueNumber: 41, runId: "run-high-cardinality" };
    const first = await reportRuntimeFailure(cwd, input);
    const second = await reportRuntimeFailure(cwd, input);
    assert.equal(first?.shouldEscalate, true);
    assert.equal(second?.sinkStatus, "suppressed");
    const lines = (await readFile(feedbackFile(cwd), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /secret-value|alice/);
  } finally {
    resetRuntimeFeedback(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
});

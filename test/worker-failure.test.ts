import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkerFailureEvidence,
  extractWorkerDiagnostic,
  formatWorkerFailure,
} from "../extensions/pi-next/worker-failure.ts";

test("worker failure keeps bounded sanitized stderr evidence", () => {
  const output = `${"noise ".repeat(2_000)}\nError: token=supersecret https://private.example/a /runner/_work/project/src/file.ts:42`;
  const evidence = createWorkerFailureEvidence(
    { output, code: 1, signal: null },
    { issueNumber: 642, runId: "run-a", phase: "implementation" },
  );
  assert.ok(evidence.diagnosticExcerpt.length <= 1_000);
  assert.doesNotMatch(evidence.diagnosticExcerpt, /supersecret|private\.example|_work/);
  assert.match(formatWorkerFailure(evidence), /Exit: 1/);
  assert.match(formatWorkerFailure(evidence), /#642/);
});

test("signal termination preserves signal and useful detail", () => {
  const evidence = createWorkerFailureEvidence(
    { output: "worker interrupted while waiting for the model", code: null, signal: "SIGTERM" },
    { phase: "implementation" },
  );
  assert.equal(evidence.category, "external");
  assert.equal(evidence.signal, "SIGTERM");
  assert.match(formatWorkerFailure(evidence), /Signal: SIGTERM/);
  assert.match(evidence.diagnosticExcerpt, /interrupted/);
});

test("ordinary repository and current-work exits are not runtime incidents", () => {
  const repository = createWorkerFailureEvidence(
    { output: "npm test failed: 2 assertions failed", code: 1, signal: null },
    { runId: "one", phase: "implementation" },
  );
  const work = createWorkerFailureEvidence(
    { output: "Error: unable to implement the requested behavior", code: 1, signal: null },
    { runId: "one", phase: "implementation" },
  );
  assert.equal(repository.category, "repository");
  assert.equal(work.category, "work");
});

test("pi-next runtime evidence has stable identity across runs and paths", () => {
  const a = createWorkerFailureEvidence(
    { output: "pi-next runtime invariant failed at /home/a/project/loop-controller.ts:12", code: 1, signal: null },
    { runId: "run-a", phase: "implementation" },
  );
  const b = createWorkerFailureEvidence(
    { output: "pi-next runtime invariant failed at /tmp/other/loop-controller.ts:99", code: 1, signal: null },
    { runId: "run-b", phase: "implementation" },
  );
  assert.equal(a.category, "runtime");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("diagnostic extraction remains bounded for long output", () => {
  assert.ok(extractWorkerDiagnostic("a\n".repeat(10_000), 120).length <= 120);
});

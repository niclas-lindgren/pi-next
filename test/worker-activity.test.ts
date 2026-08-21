import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractLiveTextDelta,
  IncrementalWorkerActivityParser,
  normalizeWorkerStreamEvent,
} from "../extensions/pi-next/worker-activity.ts";
import { parseWorkerTelemetry } from "../extensions/pi-next/worker-telemetry.ts";

const context = { issueNumber: 46, runId: "run-a", phase: "verification" };

function liveDelta(text: string, type = "text_delta") {
  return extractLiveTextDelta({
    type: "message_update",
    assistantMessageEvent: { type, delta: text },
  }, context)?.delta;
}

function failed(result: unknown, extra: Record<string, unknown> = {}) {
  return normalizeWorkerStreamEvent({
    type: "tool_execution_end",
    toolName: "bash",
    isError: true,
    result,
    ...extra,
  }, context);
}

test("streamed visible deltas preserve boundary whitespace and subword joins", () => {
  assert.equal([liveDelta("Hello"), liveDelta(" world")].join(""), "Hello world");
  assert.equal([liveDelta("foo "), liveDelta("bar")].join(""), "foo bar");
  assert.equal([liveDelta("Camp"), liveDelta("sty")].join(""), "Campsty");
  assert.equal([liveDelta("A"), liveDelta("  "), liveDelta("B")].join(""), "A  B");
});

test("streamed visible deltas preserve newlines while replacing unsafe controls", () => {
  assert.equal([liveDelta("A"), liveDelta("\n"), liveDelta("B")].join(""), "A\nB");
  assert.equal(liveDelta("A\u0000B"), "A B");
});

test("streamed visible deltas redact secrets and remain bounded", () => {
  const redacted = liveDelta("token=secret-value https://example.test/private");
  assert.ok(redacted);
  assert.doesNotMatch(redacted!, /secret-value|example\.test/);
  assert.ok(liveDelta("x".repeat(1_000))!.length <= 300);
});

test("only visible text deltas enter the live stream", () => {
  assert.equal(liveDelta("hidden", "thinking_delta"), undefined);
  assert.equal(liveDelta("hidden", "toolcall_delta"), undefined);
  assert.equal(extractLiveTextDelta({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 42 } }, context), undefined);
});

test("tool failure display retains bounded exit and sanitized reason", () => {
  const event = failed({
    details: { exitCode: 127 },
    content: [{ type: "text", text: "node_modules/.bin/tsx: command not found; token=secret-value" }],
  });
  assert.ok(event?.failureObservation);
  assert.match(event!.summary, /bash failed · exit 127/);
  assert.match(event!.summary, /command not found/);
  assert.doesNotMatch(event!.summary, /secret-value/);
  assert.ok(event!.failureObservation!.diagnosticExcerpt!.length <= 240);
  assert.equal(event!.failureObservation!.failureClass, "environment");
});

test("missing package script and verification failures have useful distinct classifications", () => {
  const missing = failed({ details: { exitCode: 1 }, stderr: 'npm ERR! Missing script: "verify:foo"' }, { toolName: "bash" });
  const red = failed({ details: { exitCode: 1 }, stderr: "2 tests failed in booking-flow.spec.ts" }, { toolName: "bash" });
  assert.equal(missing?.failureObservation?.failureClass, "repository_tooling");
  assert.equal(missing?.failureObservation?.commandClass, "package-script");
  assert.equal(red?.failureObservation?.failureClass, "expected_current_work");
  assert.equal(red?.failureObservation?.commandClass, "test");
});

test("equivalent failures fingerprint across runs and machine paths", () => {
  const a = failed({ details: { exitCode: 127 }, stderr: "/home/one/work/node_modules/.bin/tsx: command not found" }, { toolName: "bash" });
  const b = failed({ details: { exitCode: 127 }, stderr: "/tmp/two/work/node_modules/.bin/tsx: command not found" }, { toolName: "bash" });
  assert.equal(a?.failureObservation?.fingerprint, b?.failureObservation?.fingerprint);
});

test("timeout and signal evidence stay bounded and typed", () => {
  const timeout = failed({ details: { timedOut: true, durationMs: 120_000 }, stderr: "build timed out" });
  const signal = failed({ details: { signal: "SIGTERM" }, stderr: "killed by signal SIGTERM" });
  assert.match(timeout!.summary, /timed out · 120s/);
  assert.equal(timeout!.failureObservation?.failureClass, "timeout");
  assert.equal(signal!.failureObservation?.signal, "SIGTERM");
  assert.match(signal!.summary, /SIGTERM/);
});

test("incremental activity and telemetry retain the same safe failure shape", () => {
  const events: Array<NonNullable<ReturnType<typeof normalizeWorkerStreamEvent>>> = [];
  const parser = new IncrementalWorkerActivityParser(context, (event) => events.push(event));
  parser.push(JSON.stringify({ type: "session", id: "private" }) + "\n");
  parser.push(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }) + "\n");
  parser.push(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: true, result: { details: { exitCode: 1 }, stderr: "1 test failed" } }) + "\n");
  parser.finish();
  const activityFailure = events.find((event) => event.failureObservation);
  assert.equal(activityFailure?.failureObservation?.failureClass, "expected_current_work");

  const telemetry = parseWorkerTelemetry([
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: true, result: { details: { exitCode: 1 }, stderr: "1 test failed" } }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command: "npm test" } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "call-2", toolName: "bash", isError: false, result: { details: { exitCode: 0 }, stdout: "pass" } }),
    JSON.stringify({ type: "agent_end" }),
  ].join("\n"), context);
  assert.equal(telemetry.toolFailures?.length, 1);
  assert.equal(telemetry.toolFailures?.[0]?.fingerprint, activityFailure?.failureObservation?.fingerprint);
  assert.deepEqual(telemetry.recoveredToolFailureFingerprints, [telemetry.toolFailures?.[0]?.fingerprint]);
});

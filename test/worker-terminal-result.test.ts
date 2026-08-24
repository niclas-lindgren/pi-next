import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyWorkerCompletion,
  createWorkerTerminalEvidence,
  observeWorkerEvent,
} from "../src/coordination/worker-terminal-result.ts";

test("no terminal assistant/model result observed fails closed, not completed", () => {
  const classification = classifyWorkerCompletion(createWorkerTerminalEvidence());
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_UNPROVEN");
});

test("terminal stopReason=error fails closed as a typed model turn failure", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "provider 500" },
  });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) {
    assert.equal(classification.code, "MODEL_TURN_FAILED");
    assert.match(classification.detail, /provider 500/);
  }
});

test("terminal stopReason=aborted fails closed as an aborted model turn", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_ABORTED");
});

test("a normal terminal assistant result completes, even with no tool calls", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("legacy/provider successful stop aliases can complete when terminal evidence is present", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("a terminal assistant result with no stopReason is malformed and fails closed", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_UNPROVEN");
});

test("provider error event fails closed even when prompt resolves without assistant message_end", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "provider_error", code: "rate_limit", message: "429 too many requests" });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  assert.equal(evidence.terminalResultObserved, true);
  assert.equal(evidence.sawAssistantMessage, false);
  if (!classification.ok) {
    assert.equal(classification.code, "PROVIDER_ERROR");
    assert.match(classification.detail, /429/);
  }
});

test("auto retry exhaustion is a typed provider error event", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) {
    assert.equal(classification.code, "PROVIDER_ERROR");
    assert.match(classification.detail, /overloaded/);
  }
});

test("turn_end and raw stream done terminal surfaces can prove completion", () => {
  let turnEvidence = createWorkerTerminalEvidence();
  turnEvidence = observeWorkerEvent(turnEvidence, { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
  assert.deepEqual(classifyWorkerCompletion(turnEvidence), { ok: true });

  let streamEvidence = createWorkerTerminalEvidence();
  streamEvidence = observeWorkerEvent(streamEvidence, { type: "done", reason: "stop", message: { role: "assistant" } });
  assert.deepEqual(classifyWorkerCompletion(streamEvidence), { ok: true });
});

test("raw stream error reason fails closed even if nested assistant stopReason is missing", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "error", reason: "error", error: { role: "assistant", errorMessage: "bad gateway" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) {
    assert.equal(classification.code, "MODEL_TURN_FAILED");
    assert.match(classification.detail, /bad gateway/);
  }
});

test("assistant text observation is diagnostic and not sufficient for completion", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} },
  });
  assert.equal(evidence.assistantOutputObserved, true);
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_UNPROVEN");
});

test("zero telemetry is diagnostic only and does not fail a mechanically proven successful turn", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    },
  });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("non-assistant message_end events and unrelated events do not count as terminal evidence", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "user" } });
  evidence = observeWorkerEvent(evidence, { type: "tool_execution_end", toolName: "read" });
  evidence = observeWorkerEvent(evidence, "not-an-object");
  evidence = observeWorkerEvent(evidence, undefined);
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_UNPROVEN");
});

test("the latest assistant message_end wins, so recovery after a mid-turn retry can still succeed", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "transient" } });
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("a terminal error after an earlier success still fails closed", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "final failure" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.match(classification.detail, /final failure/);
});

test("two independent evidence objects retain isolated terminal-result state", () => {
  let first = createWorkerTerminalEvidence();
  let second = createWorkerTerminalEvidence();

  first = observeWorkerEvent(first, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "first failed" } });
  second = observeWorkerEvent(second, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });

  assert.equal(classifyWorkerCompletion(first).ok, false);
  assert.deepEqual(classifyWorkerCompletion(second), { ok: true });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyWorkerCompletion,
  createWorkerTerminalEvidence,
  observeWorkerEvent,
} from "../src/coordination/worker-terminal-result.ts";

test("no terminal assistant result observed fails closed, not completed", () => {
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

test("terminal stopReason=aborted fails closed as a typed model turn failure", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.equal(classification.code, "MODEL_TURN_FAILED");
});

test("a normal terminal assistant result completes, even with no tool calls", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("a terminal assistant result with no stopReason still completes", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant" } });
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
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  assert.deepEqual(classifyWorkerCompletion(evidence), { ok: true });
});

test("a terminal error after an earlier success still fails closed", () => {
  let evidence = createWorkerTerminalEvidence();
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  evidence = observeWorkerEvent(evidence, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "final failure" } });
  const classification = classifyWorkerCompletion(evidence);
  assert.equal(classification.ok, false);
  if (!classification.ok) assert.match(classification.detail, /final failure/);
});

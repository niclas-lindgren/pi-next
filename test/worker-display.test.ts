import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerDisplayController } from "../extensions/pi-next/worker-display.ts";

test("tool errors remain non-terminal until the worker explicitly finishes", () => {
  const display = new WorkerDisplayController({
    bold: (text) => text,
    fg: (_color, text) => text,
  });

  display.event({
    issueNumber: 508,
    runId: "worker-run",
    phase: "implementation",
    kind: "error",
    summary: "read failed: ENOENT PLAN.md",
  });
  let lines = display.renderLines().join("\n");
  assert.match(lines, /#508 · implementation · active/);
  assert.doesNotMatch(lines, /#508 · failed/);
  assert.match(lines, /read failed: ENOENT PLAN\.md/);

  display.event({
    issueNumber: 508,
    runId: "worker-run",
    phase: "repair",
    kind: "tool",
    summary: "repairing workflow path",
  });
  lines = display.renderLines().join("\n");
  assert.match(lines, /#508 · repair · active/);
  assert.match(lines, /repairing workflow path/);

  display.finish(508, "worker-run", "failed");
  lines = display.renderLines().join("\n");
  assert.match(lines, /#508 · failed/);
  display.dispose();
});

test("controller recovery activity keeps the worker panel alive across replacement handoff", () => {
  const display = new WorkerDisplayController({
    bold: (text) => text,
    fg: (_color, text) => text,
  });

  display.controllerActivity(47, "recovery-run", "reading authoritative issue lease");
  let lines = display.renderLines().join("\n");
  assert.match(lines, /#47 · recovery · active/);
  assert.match(lines, /reading authoritative issue lease/);

  display.finish(47, "recovery-run", "failed");
  display.controllerActivity(47, "recovery-run", "starting replacement worker");
  lines = display.renderLines().join("\n");
  assert.match(lines, /#47 · recovery · active/);
  assert.match(lines, /reading authoritative issue lease/);
  assert.match(lines, /starting replacement worker/);

  display.dispose();
});

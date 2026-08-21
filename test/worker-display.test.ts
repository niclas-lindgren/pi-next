import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerDisplayController, attachWorkerDisplay } from "../extensions/pi-next/worker-display.ts";

test("live text deltas join faithfully and completed text replaces the preview", () => {
  const display = new WorkerDisplayController({
    bold: (text) => text,
    fg: (_color, text) => text,
  });

  display.liveDelta({ issueNumber: 64, runId: "stream", delta: "Hello" });
  display.liveDelta({ issueNumber: 64, runId: "stream", delta: " world" });
  assert.match(display.renderLines().join("\n"), /Hello world/);
  display.event({
    issueNumber: 64,
    runId: "stream",
    phase: "implementation",
    kind: "assistant",
    summary: "Completed assistant message",
  });
  const lines = display.renderLines().join("\n");
  assert.match(lines, /Completed assistant message/);
  assert.doesNotMatch(lines, /Hello world/);
  display.dispose();
});

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

test("empty display attachment does not paint a fake worker", async () => {
  const paints: Array<unknown> = [];
  const ctx = {
    cwd: "/tmp/pi-next-display-test",
    hasUI: true,
    ui: {
      theme: { bold: (text: string) => text, fg: (_color: string, text: string) => text },
      setWidget: (_key: string, value: unknown) => paints.push(value),
    },
  } as never;

  const display = attachWorkerDisplay(ctx);
  await Promise.resolve();
  assert.equal(display?.renderLines().join("\n"), "");
  assert.deepEqual(paints, []);
  display?.dispose();
});

test("controller recovery activity is not rendered as a live worker row", () => {
  const display = new WorkerDisplayController({
    bold: (text) => text,
    fg: (_color, text) => text,
  });

  display.controllerActivity(47, "recovery-run", "reading authoritative issue lease");
  let lines = display.renderLines().join("\n");
  assert.match(lines, /Pi-next · #47 · controller/);
  assert.doesNotMatch(lines, /worker alive|active/);
  assert.match(lines, /reading authoritative issue lease/);

  display.controllerActivity(47, "recovery-run", "starting replacement worker");
  lines = display.renderLines().join("\n");
  assert.match(lines, /Pi-next · #47 · controller/);
  assert.doesNotMatch(lines, /worker alive|active/);
  assert.doesNotMatch(lines, /reading authoritative issue lease/);
  assert.match(lines, /starting replacement worker/);

  display.dispose();
});

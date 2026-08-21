import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerDisplayController } from "../extensions/pi-next/worker-display.ts";

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

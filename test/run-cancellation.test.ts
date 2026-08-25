import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __resetRunCancellationForTests,
  abortRun,
  getRunAbortController,
  registerRunAbortController,
} from "../extensions/pi-next/run-cancellation.ts";

test("registerRunAbortController makes a run's controller resolvable by runId and abortRun triggers it", () => {
  __resetRunCancellationForTests();
  const controller = new AbortController();
  const unregister = registerRunAbortController("run-a", controller);
  try {
    assert.equal(getRunAbortController("run-a"), controller);
    assert.equal(controller.signal.aborted, false);

    const aborted = abortRun("run-a", "stop requested");
    assert.equal(aborted, true);
    assert.equal(controller.signal.aborted, true);
  } finally {
    unregister();
  }
});

test("abortRun returns false for an unregistered or already-aborted runId", () => {
  __resetRunCancellationForTests();
  assert.equal(abortRun("no-such-run"), false);

  const controller = new AbortController();
  const unregister = registerRunAbortController("run-b", controller);
  try {
    assert.equal(abortRun("run-b"), true);
    // Calling abort a second time on an already-aborted controller is not a
    // fresh "in-process run found and stopped" signal to the caller.
    assert.equal(abortRun("run-b"), false);
  } finally {
    unregister();
  }
});

test("unregister only clears the entry if it still belongs to the same controller instance", () => {
  __resetRunCancellationForTests();
  const first = new AbortController();
  const unregisterFirst = registerRunAbortController("run-c", first);
  const second = new AbortController();
  const unregisterSecond = registerRunAbortController("run-c", second);

  // A stale unregister from the first registration must not clobber the
  // second, currently-live controller for the same runId.
  unregisterFirst();
  assert.equal(getRunAbortController("run-c"), second);

  unregisterSecond();
  assert.equal(getRunAbortController("run-c"), undefined);
});

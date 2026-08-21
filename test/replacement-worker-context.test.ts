import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __resetLiveCtxForTests,
  setLiveCtx,
} from "../extensions/pi-next/live-ctx.ts";
import { replacementWorkerContext } from "../extensions/pi-next/loop.ts";

function context(cwd: string): object {
  return { cwd, hasUI: false };
}

test("replacement worker resolves the current live context instead of the stale worker context", () => {
  const oldContext = context("/old-session");
  const replacement = context("/replacement-session");
  try {
    setLiveCtx(replacement as never);
    assert.equal(replacementWorkerContext(7), replacement);
    assert.notEqual(replacementWorkerContext(7), oldContext);
  } finally {
    __resetLiveCtxForTests();
  }
});

test("replacement worker startup fails explicitly when no live context exists", () => {
  try {
    assert.throws(
      () => replacementWorkerContext(7),
      /Replacement worker startup failed for issue #7: no live host context is available/,
    );
  } finally {
    __resetLiveCtxForTests();
  }
});

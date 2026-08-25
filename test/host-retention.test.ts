import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __resetLiveCtxForTests,
  bindLiveAutoRun,
  clearLiveAutoRunBinding,
  getLiveCtxFor,
  liveAutoRunBinding,
  setLiveCtx,
} from "../extensions/pi-next/live-ctx.ts";

test("host replacement retires the superseded run-context bridge", () => {
  const cwd = "/tmp/pi-next-retention-rebind";
  const oldCtx = { cwd, sessionManager: { getSessionId: () => "old-session" } } as never;
  const newCtx = { cwd, sessionManager: { getSessionId: () => "new-session" } } as never;

  setLiveCtx(oldCtx);
  bindLiveAutoRun(oldCtx, "replacement-run");
  setLiveCtx(newCtx);
  bindLiveAutoRun(newCtx, "replacement-run");

  assert.equal(getLiveCtxFor(cwd, "old-session"), undefined);
  assert.equal(getLiveCtxFor(cwd, "new-session"), newCtx);
  __resetLiveCtxForTests();
});

test("settled run bindings are released instead of accumulating session identity graphs", () => {
  const cwd = "/tmp/pi-next-retention-fixture";
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "retention-session" },
  } as never;
  bindLiveAutoRun(ctx, "retention-run");
  assert.equal(liveAutoRunBinding(ctx), "retention-run");

  clearLiveAutoRunBinding(cwd, "retention-run");

  assert.equal(liveAutoRunBinding(ctx), undefined);
  __resetLiveCtxForTests();
});

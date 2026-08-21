import assert from "node:assert/strict";
import { test } from "node:test";

import { ForegroundSupervisor } from "../extensions/pi-next/foreground-supervisor.ts";
import { __resetLiveCtxForTests, bindLiveAutoRun, clearLiveAutoRunBinding, liveAutoRunBinding } from "../extensions/pi-next/live-ctx.ts";

test("foreground supervisor does not retain the initial host context", () => {
  const ctx = { cwd: "/tmp/pi-next-retention-fixture" } as never;
  const supervisor = new ForegroundSupervisor(ctx);

  assert.equal("ctx" in supervisor, false);
  assert.equal((supervisor as unknown as { cwd: string }).cwd, "/tmp/pi-next-retention-fixture");
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

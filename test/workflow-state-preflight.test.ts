import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { runIssueScopedPrompt } from "../extensions/pi-next/commands.ts";
import { registerPiNextCommands } from "../extensions/pi-next/commands-recovery.ts";
import { ForegroundSupervisor } from "../extensions/pi-next/foreground-supervisor.ts";
import { preflightWorkflowStateProvider, WorkflowStateProviderError } from "../extensions/pi-next/workflow-state-provider.ts";
import { DEFAULT_PI_NEXT_CONFIG, type PiNextConfig } from "../src/coordination/config.ts";
import type { IssueLeaseAuthority } from "../extensions/pi-next/issue-leases.ts";

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-state-preflight-"));
  await mkdir(join(cwd, ".pi-next"), { recursive: true });
  return cwd;
}

async function configureHelper(cwd: string, path = ".pi-next/missing-state.sh"): Promise<void> {
  const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as PiNextConfig;
  config.workflow.stateProvider = { type: "helper", path };
  await writeFile(join(cwd, ".pi-next", "config.json"), JSON.stringify(config));
}

function context(cwd: string): {
  cwd: string;
  hasUI: boolean;
  ui: { notify: () => void; setStatus: () => void };
} {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => undefined, setStatus: () => undefined },
  };
}

test("autonomous provider preflight rejects an invalid explicit helper before creating run state", async () => {
  const cwd = await fixture();
  try {
    await configureHelper(cwd);
    await assert.rejects(
      () => preflightWorkflowStateProvider(cwd),
      (error: unknown) => error instanceof WorkflowStateProviderError && /missing/.test(error.message),
    );
    await assert.rejects(
      () => readdir(join(cwd, ".pi", "runtime", "pi-next-loops")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("issue entry rejects an invalid provider before lease claim or worker launch", async () => {
  const cwd = await fixture();
  let authorityCalls = 0;
  let workerCalls = 0;
  const authority: IssueLeaseAuthority = {
    read: async () => { authorityCalls += 1; return undefined; },
    create: async () => { authorityCalls += 1; },
    replace: async () => { authorityCalls += 1; },
    remove: async () => { authorityCalls += 1; },
  };
  try {
    await configureHelper(cwd);
    await runIssueScopedPrompt(
      context(cwd) as never,
      "#7",
      authority,
      async () => {
        workerCalls += 1;
        throw new Error("worker must not launch");
      },
    );
    assert.equal(authorityCalls, 0);
    assert.equal(workerCalls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/pi-next auto preflights before abandoned-run recovery", async () => {
  const cwd = await fixture();
  const handlers = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      handlers.set(name, command);
    },
  };
  const original = ForegroundSupervisor.recoverOnStart;
  let recoveryCalls = 0;
  (ForegroundSupervisor as unknown as {
    recoverOnStart: (ctx: unknown) => Promise<{ recovered: boolean }>;
  }).recoverOnStart = async () => {
    recoveryCalls += 1;
    return { recovered: false };
  };
  try {
    await configureHelper(cwd);
    registerPiNextCommands(pi as never);
    const command = handlers.get("pi-next");
    assert.ok(command);
    await command.handler("auto", context(cwd));
    assert.equal(recoveryCalls, 0);
  } finally {
    (ForegroundSupervisor as unknown as { recoverOnStart: typeof original }).recoverOnStart = original;
    await rm(cwd, { recursive: true, force: true });
  }
});

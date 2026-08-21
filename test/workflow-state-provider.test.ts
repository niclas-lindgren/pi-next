import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { DEFAULT_PI_NEXT_CONFIG } from "../src/coordination/config.ts";
import {
  builtInWorkflowState,
  preflightWorkflowStateProvider,
  workflowState,
  WorkflowStateProviderError,
} from "../extensions/pi-next/workflow-state-provider.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-state-provider-"));
  await mkdir(join(cwd, ".pi-next"), { recursive: true });
  return cwd;
}

async function config(cwd: string, workflow: Record<string, unknown> = {}) {
  const value = structuredClone(DEFAULT_PI_NEXT_CONFIG) as Record<string, unknown>;
  value.workflow = { ...(value.workflow as object), ...workflow };
  await writeFile(join(cwd, ".pi-next", "config.json"), JSON.stringify(value));
}

test("built-in state provider works without a helper and respects configured plan paths", async () => {
  const cwd = await fixture();
  try {
    await config(cwd, { planPath: ".workflow/PLAN.md", stateDir: ".workflow" });
    await mkdir(join(cwd, ".workflow"), { recursive: true });
    await writeFile(
      join(cwd, ".workflow", "PLAN.md"),
      "# Plan: Fixture\n\n**Goal:** portable state\n\n**GitHub-Issue:** #7\n\n## Tasks\n- [ ] implement\n- [x] done\n\n## Acceptance Criteria\n- [ ] one\n- [x] two\n\n## Log\n",
    );
    const result = await workflowState(cwd);
    assert.equal(result.provider, "builtin");
    assert.equal(await preflightWorkflowStateProvider(cwd), "builtin");
    assert.deepEqual(result.state, {
      PLAN: "present",
      TASKS: "2",
      UNCHECKED_TASKS: "1",
      ACCEPTANCE: "2",
      UNCHECKED_ACCEPTANCE: "1",
      PLAN_GOAL: "portable state",
      CURRENT_TASK: "implement",
    });
    assert.deepEqual(builtInWorkflowState(join(cwd, "empty")), {
      PLAN: "absent",
      UNCHECKED_TASKS: "0",
      UNCHECKED_ACCEPTANCE: "0",
      TASKS: "0",
      ACCEPTANCE: "0",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit helper override is authoritative and an unconfigured legacy file is ignored", async () => {
  const cwd = await fixture();
  try {
    await writeFile(join(cwd, ".pi-next", "PLAN.md"), "# Plan: built-in\n");
    await mkdir(join(cwd, ".pi-next", "scripts"), { recursive: true });
    await writeFile(join(cwd, ".pi-next", "scripts", "pi-next-state.sh"), "#!/bin/sh\nprintf 'PLAN=absent\\nUNCHECKED_TASKS=9\\nUNCHECKED_ACCEPTANCE=8\\n'\n");
    await chmod(join(cwd, ".pi-next", "scripts", "pi-next-state.sh"), 0o755);
    const builtIn = await workflowState(cwd);
    assert.equal(builtIn.provider, "builtin");
    assert.equal(builtIn.state.PLAN, "present");

    const helper = join(cwd, ".pi-next", "custom-state.sh");
    await writeFile(helper, "#!/bin/sh\nprintf 'PLAN=absent\\nUNCHECKED_TASKS=4\\nUNCHECKED_ACCEPTANCE=3\\nPLAN_GOAL=consumer\\n'\n");
    await chmod(helper, 0o755);
    await config(cwd, { stateProvider: { type: "helper", path: ".pi-next/custom-state.sh" } });
    const overridden = await workflowState(cwd);
    assert.equal(overridden.provider, "helper");
    assert.equal(await preflightWorkflowStateProvider(cwd), "helper");
    assert.equal(overridden.state.PLAN_GOAL, "consumer");
    assert.equal(overridden.state.PLAN, "absent");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("broken explicit providers fail without fallback", async () => {
  const cwd = await fixture();
  try {
    await config(cwd, { stateProvider: { type: "helper", path: ".pi-next/missing.sh" } });
    await assert.rejects(() => workflowState(cwd), (error: unknown) =>
      error instanceof WorkflowStateProviderError && /missing/.test(error.message),
    );
    const malformed = join(cwd, ".pi-next", "malformed.sh");
    await writeFile(malformed, "#!/bin/sh\nprintf 'PLAN=present\\n'\n");
    await chmod(malformed, 0o755);
    await config(cwd, { stateProvider: { type: "helper", path: ".pi-next/malformed.sh" } });
    await assert.rejects(() => workflowState(cwd), /UNCHECKED_TASKS/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

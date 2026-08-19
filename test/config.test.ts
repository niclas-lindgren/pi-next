import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryWorkAuthority,
  PiNextConfigError,
  validatePiNextConfig,
} from "../src/coordination/index.ts";
import { candidateShortlist } from "../extensions/pi-next/issue-candidates.ts";
import { buildAutoPrompt } from "../extensions/pi-next/prompt.ts";

const config = {
  version: 1,
  authority: {
    adapter: "memory",
    projectStatus: { todo: "queued", inProgress: "working", done: "complete", blocked: "paused" },
  },
  selection: {
    priorities: ["urgent", "normal"],
    readyStates: ["prepared"],
    blockedStates: ["paused"],
  },
  repositoryPolicy: { entrypoints: ["POLICY.md"] },
  workflow: {
    stateDir: ".workflow",
    planPath: ".workflow/PLAN.md",
    verifyPath: ".workflow/VERIFY.md",
    archiveDir: ".workflow/ARCHIVED",
    deferredDir: ".workflow/deferred",
    skillPath: ".workflow/SKILL.md",
    tuningPath: ".workflow/LOOP_TUNING.md",
    helperDir: ".workflow/scripts",
  },
} as const;
const validatedConfig = validatePiNextConfig(config);

test("versioned configuration validates custom authority and workflow policy", () => {
  const validated = validatePiNextConfig(config);
  assert.equal(validated.authority.adapter, "memory");
  assert.deepEqual(validated.selection.priorities, ["urgent", "normal"]);
  assert.equal(validated.workflow.planPath, ".workflow/PLAN.md");
  assert.throws(
    () => validatePiNextConfig({ ...config, unsupported: true }),
    (error: unknown) => error instanceof PiNextConfigError && /unsupported/.test(error.message),
  );
  assert.throws(
    () => validatePiNextConfig({ ...config, workflow: { ...config.workflow, planPath: "../PLAN.md" } }),
    PiNextConfigError,
  );
});

test("a non-GitHub authority can provide configurable candidates", async () => {
  const authority = new InMemoryWorkAuthority([
    {
      id: "local-7",
      number: 7,
      title: "local work item",
      body: "",
      state: "open",
      updatedAt: "2026-01-01T00:00:00Z",
      priority: "urgent",
      states: ["prepared"],
      comments: [],
    },
    {
      id: "local-8",
      number: 8,
      title: "paused work item",
      body: "",
      state: "open",
      priority: "urgent",
      states: ["paused"],
      comments: [],
    },
  ]);
  const result = await candidateShortlist("/tmp", {
    authority,
    config: validatedConfig,
    refreshMain: false,
  });
  assert.match(result.text || "", /urgent:\n- #7 local work item/);
  assert.doesNotMatch(result.text || "", /paused work item/);
});

test("prompt policy comes from configuration rather than hidden repository conventions", () => {
  const prompt = buildAutoPrompt({ config: validatePiNextConfig(config) });
  assert.match(prompt, /POLICY\.md/);
  assert.match(prompt, /memory authority/);
  assert.match(prompt, /urgent/);
  assert.doesNotMatch(prompt, /Campsty|AGENTS\.md/);
});

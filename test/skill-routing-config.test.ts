import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PI_NEXT_CONFIG,
  PiNextConfigError,
  validatePiNextConfig,
} from "../src/coordination/config.ts";

function baseConfig(skills: unknown): Record<string, unknown> {
  return {
    version: 1,
    authority: { adapter: "github", projectStatus: { todo: "Todo", inProgress: "In Progress", done: "Done", blocked: "Blocked" } },
    selection: { priorities: ["P0"], readyStates: ["ready"], blockedStates: ["blocked"] },
    repositoryPolicy: { entrypoints: [] },
    workflow: {
      stateDir: ".pi-next",
      planPath: ".pi-next/PLAN.md",
      verifyPath: ".pi-next/VERIFY.md",
      archiveDir: ".pi-next/ARCHIVED",
      deferredDir: ".pi-next/deferred",
      skillPath: ".pi-next/SKILL.md",
      tuningPath: ".pi-next/LOOP_TUNING.md",
      diagnosticsPath: ".pi-next/diagnostics",
      helperDir: ".pi-next/scripts",
    },
    skills,
  };
}

test("missing skills config uses the built-in default routing policy", () => {
  const config = baseConfig(undefined);
  delete config.skills;
  const validated = validatePiNextConfig(config);
  assert.deepEqual(validated.skills, DEFAULT_PI_NEXT_CONFIG.skills);
  assert.equal(validated.skills.version, 1);
});

test("valid mandatory/automatic/explicit routing policy is accepted", () => {
  const validated = validatePiNextConfig(baseConfig({
    version: 1,
    mandatory: [{ skill: "verification-before-completion", roles: ["verification"], reason: "terminal-gate" }],
    automatic: [{ skill: "tdd", roles: ["implementation"], taskPattern: "test", risk: ["normal", "high"] }],
    explicit: ["codebase-design"],
  }));
  assert.equal(validated.skills.mandatory[0].skill, "verification-before-completion");
  assert.deepEqual(validated.skills.explicit, ["codebase-design"]);
});

test("distinct-category and repeated-id automatic rules are accepted", () => {
  // diagnosing-bugs (debugging) and code-review (code-review) are different
  // methodology axes, and repeating the same skill id under different
  // conditions is not a conflict.
  const validated = validatePiNextConfig(baseConfig({
    version: 1,
    mandatory: [],
    automatic: [
      { skill: "diagnosing-bugs", roles: ["repair"] },
      { skill: "code-review", roles: ["review-spec"] },
      { skill: "code-review", roles: ["review-standards"] },
    ],
    explicit: [],
  }));
  assert.equal(validated.skills.automatic.length, 3);
});

test("unknown skill reference in config fails closed", () => {
  assert.throws(
    () => validatePiNextConfig(baseConfig({ version: 1, mandatory: [], automatic: [{ skill: "totally-unknown" }], explicit: [] })),
    (error: unknown) => error instanceof PiNextConfigError && /not present in the reviewed registry/.test(error.message),
  );
});

test("invalid task pattern and version fail closed", () => {
  assert.throws(
    () => validatePiNextConfig(baseConfig({ version: 2, mandatory: [], automatic: [], explicit: [] })),
    (error: unknown) => error instanceof PiNextConfigError && /config.skills.version/.test(error.message),
  );
  assert.throws(
    () => validatePiNextConfig(baseConfig({ version: 1, mandatory: [], automatic: [{ skill: "tdd", taskPattern: "(" }], explicit: [] })),
    (error: unknown) => error instanceof PiNextConfigError && /not a valid regular expression/.test(error.message),
  );
});

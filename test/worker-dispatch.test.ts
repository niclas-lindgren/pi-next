import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  capabilityForRole,
  classifyWorkerRole,
  createWorkerDispatch,
  dispatchBindingMatches,
  renderWorkerEnvelope,
  selectWorkerSkills,
} from "../src/coordination/worker-dispatch.ts";
import { buildLoopPrompt, buildPiNextPrompt, resolveWorkerSkill } from "../extensions/pi-next/prompt.ts";
import { DEFAULT_PI_NEXT_CONFIG } from "../src/coordination/config.ts";

test("worker role and capability are derived from controller phase", () => {
  assert.equal(classifyWorkerRole({ phase: "planning" }), "planning");
  assert.equal(classifyWorkerRole({ phase: "repair", task: "fix regression" }), "repair");
  assert.equal(classifyWorkerRole({ phase: "review-spec" }), "review-spec");
  assert.equal(capabilityForRole("review-standards"), "read-only-reviewer");
  assert.equal(capabilityForRole("implementation"), "mutable-owner");
});

test("skill routing is selective and deterministic", () => {
  assert.deepEqual(selectWorkerSkills("controller"), []);
  assert.deepEqual(selectWorkerSkills("repair", { task: "repair regression" }), ["diagnosing-bugs", "tdd"]);
  assert.deepEqual(selectWorkerSkills("review-spec"), ["code-review"]);
  assert.deepEqual(selectWorkerSkills("review-standards", { risk: "high" }), ["code-review", "codebase-design"]);
});

test("every selected built-in skill resolves from the package or managed pack", () => {
  const roles = ["controller", "planning", "implementation", "repair", "review-spec", "review-standards", "verification", "maintenance"] as const;
  const skills = new Set(roles.flatMap((role) => selectWorkerSkills(role, { risk: "high", task: "test regression repair" })));
  for (const skill of skills) {
    assert.notEqual(resolveWorkerSkill(process.cwd(), skill).source, "optional-unavailable", skill);
  }
});

test("dispatch envelope binds identity and exposes bounded metadata", () => {
  const policy = createWorkerDispatch({
    phase: "review-spec",
    issueNumber: 42,
    authorityFingerprint: "authority-1",
    candidateSha: "candidate-1",
    fixedPointSha: "main-1",
  });
  assert.equal(policy.capabilityProfile, "read-only-reviewer");
  assert.match(renderWorkerEnvelope(policy), /role=review-spec/);
  assert.match(renderWorkerEnvelope(policy), /no writes/);
  assert.match(renderWorkerEnvelope({
    ...policy,
    workflowPaths: {
      plan: ".workflow/PLAN.md",
      verify: ".workflow/VERIFY.md",
      state: ".workflow",
      diagnostics: ".workflow/diagnostics",
    },
  }), /PLAN=\.workflow\/PLAN\.md VERIFY=\.workflow\/VERIFY\.md/);
  assert.equal(dispatchBindingMatches(policy, policy), true);
  assert.equal(dispatchBindingMatches(policy, { ...policy, candidateSha: "candidate-2" }), false);
});

test("custom workflow paths are bound into the worker prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-dispatch-paths-"));
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    const config = structuredClone(DEFAULT_PI_NEXT_CONFIG);
    config.workflow.planPath = ".workflow/PLAN.md";
    config.workflow.verifyPath = ".workflow/VERIFY.md";
    config.workflow.stateDir = ".workflow";
    config.workflow.diagnosticsPath = ".workflow/diagnostics";
    await writeFile(join(cwd, ".pi-next", "config.json"), JSON.stringify(config));
    const prompt = buildPiNextPrompt(cwd, "continue");
    assert.match(prompt, /PLAN=\.workflow\/PLAN\.md VERIFY=\.workflow\/VERIFY\.md STATE=\.workflow/);
    assert.match(prompt, /never probe root or another harness/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plan repair dispatch is planning-only and bounded", () => {
  const prompt = buildLoopPrompt({
    mode: "resume",
    runId: "repair-run",
    step: 2,
    maxSteps: 10,
    remainingIssues: 1,
    hasPlan: true,
    planRepair: {
      issueNumber: 641,
      errors: ["Task missing Files: render marketing root", "Task missing Approach: render marketing root"],
      attempt: 1,
      maxAttempts: 2,
    },
    dispatch: createWorkerDispatch({ phase: "planning", hasPlan: true, issueNumber: 641 }),
  });
  assert.match(prompt, /PLAN REPAIR MODE \(attempt 1\/2\)/);
  assert.match(prompt, /Do not edit product source, tests, or requirements/);
  assert.match(prompt, /Do not implement any product task/);
  assert.match(prompt, /Task missing Files/);
});

test("default issue prompt is compact and does not inject legacy long-form policy", () => {
  const prompt = buildPiNextPrompt(process.cwd(), "implement the selected task", undefined, {
    phase: "implementation",
    task: "implement a small change",
  });
  assert.match(prompt, /role=implementation/);
  assert.match(prompt, /Selected skills:/);
  assert.match(prompt, /Authoritative workflow paths: PLAN=\.pi-next\/PLAN\.md VERIFY=\.pi-next\/VERIFY\.md/);
  assert.doesNotMatch(prompt, /The complete long-form/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityForRole,
  classifyWorkerRole,
  createWorkerDispatch,
  dispatchBindingMatches,
  renderWorkerEnvelope,
  selectWorkerSkills,
} from "../src/coordination/worker-dispatch.ts";
import { buildPiNextPrompt } from "../extensions/pi-next/prompt.ts";

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
  assert.equal(dispatchBindingMatches(policy, policy), true);
  assert.equal(dispatchBindingMatches(policy, { ...policy, candidateSha: "candidate-2" }), false);
});

test("default issue prompt is compact and does not inject legacy long-form policy", () => {
  const prompt = buildPiNextPrompt(process.cwd(), "implement the selected task", undefined, {
    phase: "implementation",
    task: "implement a small change",
  });
  assert.match(prompt, /role=implementation/);
  assert.match(prompt, /Selected skills:/);
  assert.doesNotMatch(prompt, /The complete long-form/);
});

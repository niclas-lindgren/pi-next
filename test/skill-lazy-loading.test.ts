import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_PI_NEXT_CONFIG } from "../src/coordination/config.ts";
import { buildPiNextPrompt } from "../extensions/pi-next/prompt.ts";
import { createWorkerDispatch } from "../src/coordination/worker-dispatch.ts";

const REPO_ROOT = process.cwd();

test("review-spec loads only the spec-conformance discipline with exact bindings", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "review the candidate", undefined, {
    phase: "review-spec",
    issueNumber: 172,
    authorityFingerprint: "authority-1",
    candidateSha: "c1",
    fixedPointSha: "f1",
    boundInputs: { specEvidence: "issue #172 acceptance criteria" },
  });
  assert.match(prompt, /Selected skills: code-review-spec/);
  assert.match(prompt, /code-review-spec \[package\]/);
  assert.match(prompt, /candidate=c1/);
  assert.match(prompt, /fixed-point=f1/);
  assert.match(prompt, /specEvidence=issue #172 acceptance criteria/);
  assert.match(prompt, /Do not run or duplicate standards\/design review/);
  assert.doesNotMatch(prompt, /code-review-standards \[package\]/);
  assert.doesNotMatch(prompt, /Both axes run as \*\*parallel sub-agents\*\*/);
  assert.doesNotMatch(prompt, /If they didn't specify one, ask for it/);
  assert.doesNotMatch(prompt, /tdd \[package\]/);
  assert.doesNotMatch(prompt, /diagnosing-bugs \[package\]/);
});

test("review-standards loads only the standards discipline with exact bindings", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "review the candidate", undefined, {
    phase: "review-standards",
    risk: "normal",
    issueNumber: 172,
    authorityFingerprint: "authority-1",
    candidateSha: "c1",
    fixedPointSha: "f1",
    boundInputs: { standardsSources: "AGENTS.md, docs/WORKERS.md" },
  });
  assert.match(prompt, /Selected skills: code-review-standards, codebase-design/);
  assert.match(prompt, /code-review-standards \[package\]/);
  assert.match(prompt, /standardsSources=AGENTS\.md, docs\/WORKERS\.md/);
  assert.match(prompt, /Do not run or duplicate spec-conformance review/);
  assert.doesNotMatch(prompt, /code-review-spec \[package\]/);
  assert.doesNotMatch(prompt, /Spec sub-agent prompt/);
});

test("a dispatch with no matching rule loads no skill body", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "small change", undefined, { phase: "implementation", task: "rename a local variable" });
  assert.match(prompt, /Selected skills: none/);
  assert.doesNotMatch(prompt, /Selected worker methodology/);
});

test("worker envelope records exact provenance and compatibility for selected skills only", () => {
  const dispatch = createWorkerDispatch({ phase: "repair", task: "fix regression", issueNumber: 5 });
  assert.ok(dispatch.skillSelection);
  assert.deepEqual(dispatch.skills, ["diagnosing-bugs", "tdd"]);
  const selected = dispatch.skillSelection!.selected;
  assert.ok(selected.every((skill) => skill.provenanceVersion && skill.source && skill.tier && skill.compatibility.adaptation.provenance));
  assert.equal(selected.find((skill) => skill.id === "tdd")?.compatibility.status, "typed-blocked");
  // available count exceeds the loaded set: installed != loaded.
  assert.ok(dispatch.skillSelection!.availableCount > dispatch.skills.length);
});

test("unattended TDD with a bound seam proceeds without typed block instructions", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "add behavior regression test", undefined, {
    phase: "implementation",
    task: "add behavior regression test",
    boundInputs: { testingSeam: "test/skill-lazy-loading.test.ts public prompt contract" },
  });
  assert.match(prompt, /Selected skills: tdd/);
  assert.match(prompt, /tdd \[package\]/);
  assert.match(prompt, /testingSeam=test\/skill-lazy-loading\.test\.ts public prompt contract/);
  assert.match(prompt, /smallest failing behavioral test/);
  assert.doesNotMatch(prompt, /Typed skill block required/);
  assert.match(prompt, /\[automatic;compatible;pi-next-adapter/);
});

test("unattended TDD without a bound seam instructs a typed bounded result", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "add behavior regression test", undefined, {
    phase: "implementation",
    task: "add behavior regression test",
  });
  assert.match(prompt, /Selected skills: tdd/);
  assert.match(prompt, /MISSING_BOUND_SKILL_INPUT/);
  assert.match(prompt, /missingInputs/);
  assert.match(prompt, /testingSeam/);
});

test("configured mandatory verification discipline is loaded for verification role", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-skill-mandatory-"));
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as Record<string, unknown>;
    (config as { skills: unknown }).skills = {
      version: 1,
      mandatory: [{ skill: "verification-before-completion", roles: ["verification"] }],
      automatic: [],
      explicit: [],
    };
    await writeFile(join(cwd, ".pi-next", "config.json"), JSON.stringify(config));
    const prompt = buildPiNextPrompt(cwd, "verify completion", undefined, { phase: "verification", candidateSha: "c1" });
    assert.match(prompt, /Selected skills: verification-before-completion/);
    assert.match(prompt, /\[mandatory;compatible;pi-next-adapter/);
    // The verification discipline body is loaded from the package skill root.
    assert.match(prompt, /Verification before completion/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

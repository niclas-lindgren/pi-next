import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_PI_NEXT_CONFIG } from "../src/coordination/config.ts";
import { buildPiNextPrompt } from "../extensions/pi-next/prompt.ts";
import { createWorkerDispatch } from "../src/coordination/worker-dispatch.ts";

const REPO_ROOT = process.cwd();

test("only the selected skill is loaded into the worker packet", () => {
  // review-spec selects code-review; unselected installed skills must not appear.
  const prompt = buildPiNextPrompt(REPO_ROOT, "review the candidate", undefined, { phase: "review-spec", candidateSha: "c1" });
  assert.match(prompt, /Selected skills: code-review/);
  assert.match(prompt, /code-review \[package\]/);
  // Bodies of installed-but-unselected skills are absent from the packet.
  assert.doesNotMatch(prompt, /tdd \[package\]/);
  assert.doesNotMatch(prompt, /diagnosing-bugs \[package\]/);
});

test("a dispatch with no matching rule loads no skill body", () => {
  const prompt = buildPiNextPrompt(REPO_ROOT, "small change", undefined, { phase: "implementation", task: "rename a local variable" });
  assert.match(prompt, /Selected skills: none/);
  assert.doesNotMatch(prompt, /Selected worker methodology/);
});

test("worker envelope records exact provenance for selected skills only", () => {
  const dispatch = createWorkerDispatch({ phase: "repair", task: "fix regression", issueNumber: 5 });
  assert.ok(dispatch.skillSelection);
  assert.deepEqual(dispatch.skills, ["diagnosing-bugs", "tdd"]);
  const selected = dispatch.skillSelection!.selected;
  assert.ok(selected.every((skill) => skill.provenanceVersion && skill.source && skill.tier));
  // available count exceeds the loaded set: installed != loaded.
  assert.ok(dispatch.skillSelection!.availableCount > dispatch.skills.length);
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
    assert.match(prompt, /\[mandatory\]/);
    // The verification discipline body is loaded from the package skill root.
    assert.match(prompt, /Verification before completion/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

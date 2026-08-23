import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBoundedRepoMap, buildContextPacket, resolveSkillContext } from "../src/evaluation/context-strategies.ts";
import { ScriptedWorkerAdapter } from "../src/evaluation/scripted-worker-adapter.ts";
import { runWorkerCanaryCorpus, runWorkerCanaryFixture, workerCanaryFixtures, WORKER_CANARY_FIXTURE_FORMAT_VERSION } from "../src/evaluation/worker-canaries.ts";

test("worker canary corpus has representative independently graded fixtures", () => {
  assert.equal(WORKER_CANARY_FIXTURE_FORMAT_VERSION, 1);
  assert.ok(workerCanaryFixtures.length >= 5);
  const categories = new Set(workerCanaryFixtures.map((fixture) => fixture.category));
  for (const expected of [
    "localized bug fix",
    "behavior change with tests",
    "small multi-file refactor",
    "repository inspection + targeted change",
    "failure diagnosis/repair",
    "repository contract adherence",
  ]) assert.ok(categories.has(expected), `missing ${expected}`);
  for (const fixture of workerCanaryFixtures) {
    assert.ok(fixture.hiddenAssertions.length > 0, `${fixture.id} must have hidden grader assertions`);
    assert.ok(!fixture.task.includes("hiddenAssertions"));
  }
});

test("worker prose/terminal success cannot mark a canary PASS", async () => {
  const fixture = workerCanaryFixtures[0];
  const adapter = new ScriptedWorkerAdapter([{ name: "prose-only", behavior: "success", output: "done, all fixed" }]);
  const result = await runWorkerCanaryFixture(adapter, fixture);
  assert.equal(result.workerOk, true);
  assert.equal(result.passed, false);
  assert.ok(result.graderFailures.length > 0);
});

test("aggregate report includes tokens and cost per verified completion when available", async () => {
  const fixture = workerCanaryFixtures[0];
  const adapter = new ScriptedWorkerAdapter([{
    writes: [{ path: "src/math.ts", content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n" }],
    result: {
      ok: true,
      output: "fixed",
      code: 0,
      signal: null,
      telemetry: { status: "complete", usage: { input: 6, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 11, cost: 0.02 } },
    },
  }]);
  const report = await runWorkerCanaryCorpus(adapter, [fixture]);
  assert.equal(report.passed, 1);
  assert.equal(report.totalTokens, 11);
  assert.ok(report.totalEstimatedPromptTokens > 0);
  assert.equal(report.tokensPerVerifiedCompletion, 11);
  assert.equal(report.costPerVerifiedCompletion, 0.02);
});

test("checked-in Pi baseline records a real graded corpus run", () => {
  const baseline = JSON.parse(readFileSync("docs/evaluation/pi-worker-baseline.initial.json", "utf8"));
  assert.equal(baseline.adapter?.id, "pi");
  assert.equal(baseline.harness?.fixtureFormatVersion, WORKER_CANARY_FIXTURE_FORMAT_VERSION);
  assert.equal(baseline.fixtureCount, workerCanaryFixtures.length);
  assert.equal(typeof baseline.passed, "number");
  assert.equal(typeof baseline.passRate, "number");
  assert.equal(typeof baseline.totalWallTimeMs, "number");
  assert.equal(typeof baseline.totalRetries, "number");
  assert.equal(typeof baseline.humanInterventionRequired, "boolean");
  assert.ok(baseline.totalWallTimeMs > 0);
  assert.notEqual(baseline.status, "credential-gated-not-run-in-repository-tests");
  assert.ok(Array.isArray(baseline.results));
  assert.equal(baseline.results.length, workerCanaryFixtures.length);
  for (const result of baseline.results) {
    assert.equal(result.adapter?.id, "pi");
    assert.equal(typeof result.passed, "boolean");
    assert.equal(typeof result.wallTimeMs, "number");
    assert.equal(typeof result.retries, "number");
    assert.equal(typeof result.humanInterventionRequired, "boolean");
    assert.ok(!result.graderFailures?.some((failure: string) => /done|completed/i.test(failure)), "grader failures must be mechanical, not worker prose");
  }
});

test("context strategies keep unavailable payload out of worker prompt and telemetry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-context-test-"));
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "math.ts"), "export function add(a:number,b:number){return a-b}\n", "utf8");
    const minimal = await buildContextPacket({ cwd, task: "Fix add and run tests", strategy: "minimal" });
    assert.equal(minimal.skills.loaded.length, 0);
    assert.equal(minimal.skills.totalEstimatedTokens, 0);
    assert.ok(!minimal.prompt.includes("git push"), "minimal coding packet should not duplicate lifecycle authority prose");

    const resolver = await buildContextPacket({ cwd, task: "Repair the failing regression test for add", strategy: "resolver" });
    assert.ok(resolver.skills.available > resolver.skills.loaded.length);
    assert.ok(resolver.skills.loaded.some((skill) => skill.id === "matt-pocock.tdd"));
    assert.ok(resolver.skills.loaded.every((skill) => resolver.prompt.includes(skill.id)));
    assert.ok(!resolver.prompt.includes("expanded.frontend-browser-checks"), "available but unselected expanded skills must add no payload");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounded repo map stays within explicit budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-repo-map-test-"));
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "config.ts"), "export const DEFAULT_TIMEOUT_MS = 30000;\n", "utf8");
    await writeFile(join(cwd, "README.md"), "Default worker timeout: 45000 ms.\n", "utf8");
    const map = await buildBoundedRepoMap(cwd, "update config timeout from docs", { maxBytes: 180, maxFiles: 2 });
    assert.ok(Buffer.byteLength(map, "utf8") <= 180);
    assert.match(map, /Repo-map files included: [0-2]/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verification discipline is explicit rather than globally mandatory", () => {
  const baseline = resolveSkillContext({ role: "implementation", task: "Fix add", strategy: "resolver" });
  assert.ok(!baseline.selected.some((skill) => skill.id === "superpowers.verification-before-completion"));
  const explicit = resolveSkillContext({ role: "implementation", task: "Fix add", strategy: "verification-discipline" });
  assert.ok(explicit.selected.some((skill) => skill.id === "superpowers.verification-before-completion"));
});

test("independent grader can pass a mechanically correct candidate", async () => {
  const fixture = workerCanaryFixtures[0];
  const adapter = new ScriptedWorkerAdapter([{
    name: "real-fix",
    writes: [{ path: "src/math.ts", content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n" }],
    behavior: "success",
    result: {
      ok: true,
      output: "fixed",
      code: 0,
      signal: null,
      telemetry: {
        status: "complete",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: 0.001 },
        activity: { modelRounds: 1, toolCalls: 1, toolResults: 1 },
        model: "scripted/test",
      },
    },
  }]);
  const result = await runWorkerCanaryFixture(adapter, fixture);
  assert.equal(result.passed, true);
  assert.equal(result.usage?.totalTokens, 17);
  assert.equal(result.adapter.model, "scripted/test");
  assert.equal(result.harness.fixtureFormatVersion, 1);
});

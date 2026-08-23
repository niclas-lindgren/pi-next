import assert from "node:assert/strict";
import { test } from "node:test";

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
  assert.equal(report.tokensPerVerifiedCompletion, 11);
  assert.equal(report.costPerVerifiedCompletion, 0.02);
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

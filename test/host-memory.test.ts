import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  analyzeHostMemoryEnvelope,
  classifyHostMemoryPressure,
  hostMemoryNeedsRestart,
  hostMemoryFile,
  observeHostMemory,
} from "../extensions/pi-next/host-memory.ts";

const usage = (heapUsed: number, rss = heapUsed * 2) => ({
  heapUsed,
  heapTotal: heapUsed,
  rss,
  external: 10,
  arrayBuffers: 2,
});

test("host memory pressure classification is conservative and deterministic", () => {
  const policy = { highHeapRatio: 0.7, criticalHeapRatio: 0.9, criticalStreak: 2 };
  assert.equal(classifyHostMemoryPressure(600, 1_000, policy), "normal");
  assert.equal(classifyHostMemoryPressure(750, 1_000, policy), "high");
  assert.equal(classifyHostMemoryPressure(950, 1_000, policy), "critical");
  assert.equal(hostMemoryNeedsRestart("critical", 1, policy), false);
  assert.equal(hostMemoryNeedsRestart("critical", 2, policy), true);
});

test("forced-GC diagnostics are opt-in and expose retained settled growth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-gc-"));
  const runtime = globalThis as unknown as { gc?: () => void };
  const previousGc = runtime.gc;
  let gcCalls = 0;
  runtime.gc = () => { gcCalls += 1; };
  try {
    const samples = [];
    for (let index = 0; index < 51; index += 1) {
      const heapUsed = index === 25 ? 400 : 100 + Math.min(index, 50);
      samples.push(observeHostMemory(
        cwd,
        { boundary: "worker_end", runId: "gc-run", step: index },
        usage(heapUsed),
        1_000,
        {},
        { forceGc: true },
      ).sample);
    }
    const envelope = analyzeHostMemoryEnvelope(samples, 60);
    assert.equal(gcCalls, 51);
    assert.equal(envelope.retainedSampleCount, 51);
    assert.equal(envelope.settledGrowthBytes, 50);
    assert.equal(envelope.transientPeakBytes, 250);
    assert.equal(envelope.bounded, true);

    const leaking = samples.map((sample, index) => ({
      ...sample,
      retainedHeapUsed: 100 + index * 3,
    }));
    assert.equal(analyzeHostMemoryEnvelope(leaking, 60).bounded, false);
  } finally {
    if (previousGc === undefined) delete runtime.gc;
    else runtime.gc = previousGc;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repeated critical boundaries produce bounded, payload-free restart evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-"));
  try {
    const policy = { highHeapRatio: 0.7, criticalHeapRatio: 0.9, criticalStreak: 2 };
    const first = observeHostMemory(cwd, { boundary: "worker_end", runId: "run-1", issueNumber: 69, step: 1 }, usage(950), 1_000, policy);
    assert.equal(first.health.restartRequired, false);
    const second = observeHostMemory(cwd, { boundary: "before_session_transition", runId: "run-1", issueNumber: 69, step: 2 }, usage(960), 1_000, policy);
    assert.equal(second.health.restartRequired, true);
    assert.equal(second.health.samples.length, 2);
    assert.equal(second.sample.fromBaselineHeapUsed, 10);
    const persisted = JSON.parse(await readFile(hostMemoryFile(cwd), "utf8")) as Record<string, unknown>;
    assert.equal("prompt" in persisted, false);
    assert.equal("transcript" in persisted, false);
    assert.equal((persisted.samples as unknown[]).length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a new run gets a new memory baseline instead of inheriting historical growth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-host-memory-baseline-"));
  try {
    observeHostMemory(cwd, { boundary: "auto_start", runId: "run-1" }, usage(800), 1_000);
    const next = observeHostMemory(cwd, { boundary: "auto_start", runId: "run-2" }, usage(300), 1_000);
    assert.equal(next.sample.fromBaselineHeapUsed, 0);
    assert.equal(next.health.baselineHeapUsed, 300);
    assert.equal(next.health.criticalStreak, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

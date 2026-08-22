import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_ADAPTER_VERSION,
  type WorkerEvent,
} from "../src/coordination/worker-adapter.ts";
import { createWorkerDispatch } from "../src/coordination/worker-dispatch.ts";
import {
  PiWorkerAdapter,
  issueWorkerRunnerFromAdapter,
  type PiWorkerCompatibleAdapter,
} from "../extensions/pi-next/pi-worker-adapter.ts";
import type {
  IssueWorkerOptions,
  IssueWorkerResult,
  IssueWorkerRunner,
} from "../extensions/pi-next/util-core.ts";

const successResult = (): IssueWorkerResult => ({
  ok: true,
  output: "",
  code: 0,
  signal: null,
  telemetry: {
    status: "complete",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: 0.001,
    },
    activity: { modelRounds: 1, toolCalls: 2, toolResults: 2 },
    model: "test-model",
  },
});

test("PiWorkerAdapter delegates exact cwd, dispatch, cancellation and telemetry", async () => {
  const dispatch = createWorkerDispatch({
    phase: "implementation",
    issueNumber: 75,
    authorityFingerprint: "authority-75",
    candidateSha: "candidate-75",
    fixedPointSha: "main-75",
  });
  const controller = new AbortController();
  let observedCwd = "";
  let observedPrompt = "";
  let observedOptions: IssueWorkerOptions | undefined;

  const runner: IssueWorkerRunner = async (cwd, prompt, options = {}) => {
    observedCwd = cwd;
    observedPrompt = prompt;
    observedOptions = options;
    return successResult();
  };
  const adapter = new PiWorkerAdapter(runner);
  const result = await adapter.run({
    cwd: "/tmp/canonical-issue-75",
    prompt: "bounded task",
    issueNumber: 75,
    runId: "run-75",
    phase: "implementation",
    dispatch,
    coordinationCwd: "/tmp/coordination",
  }, controller.signal);

  assert.equal(adapter.id, "pi");
  assert.equal(adapter.version, WORKER_ADAPTER_VERSION);
  assert.equal(observedCwd, "/tmp/canonical-issue-75");
  assert.equal(observedPrompt, "bounded task");
  assert.equal(observedOptions?.signal, controller.signal);
  assert.equal(observedOptions?.dispatch, dispatch);
  assert.equal(observedOptions?.issueNumber, 75);
  assert.equal(observedOptions?.runId, "run-75");
  assert.equal(observedOptions?.coordinationCwd, "/tmp/coordination");
  assert.deepEqual(result.telemetry, successResult().telemetry);
});

test("PiWorkerAdapter exposes bounded typed activity/runtime/watchdog events", async () => {
  const events: WorkerEvent[] = [];
  const runner: IssueWorkerRunner = async (_cwd, _prompt, options = {}) => {
    options.onActivity?.({
      issueNumber: 75,
      runId: "run-75",
      phase: "implementation",
      kind: "edit",
      summary: "editing worker adapter",
      relatedPaths: ["src/coordination/worker-adapter.ts"],
    });
    options.onWorkerState?.({
      pid: 123,
      startedAt: "2026-08-22T12:00:00.000Z",
      lastActivityAt: "2026-08-22T12:00:01.000Z",
      lastActivityKind: "edit",
      alive: true,
    });
    options.onWatchdog?.({
      kind: "suspected_stall",
      issueNumber: 75,
      runId: "run-75",
      phase: "implementation",
      pid: 123,
      wallClockMs: 3_000,
      idleMs: 2_000,
      lastActivityAt: "2026-08-22T12:00:01.000Z",
      lastActivityKind: "edit",
      reason: "synthetic watchdog evidence",
    });
    return successResult();
  };

  await new PiWorkerAdapter(runner).run(
    { cwd: "/tmp/issue-75", prompt: "task" },
    new AbortController().signal,
    (event) => events.push(event),
  );

  assert.deepEqual(events.map((event) => event.type), ["activity", "runtime", "watchdog"]);
  assert.deepEqual(events[0], {
    type: "activity",
    phase: "implementation",
    kind: "edit",
    summary: "editing worker adapter",
    relatedPaths: ["src/coordination/worker-adapter.ts"],
  });
  assert.equal("prompt" in events[0], false);
  assert.equal("output" in events[0], false);
});

test("adapter runner bridge allows a fake adapter without launching Pi", async () => {
  const dispatch = createWorkerDispatch({ phase: "planning", issueNumber: 75 });
  const seen: Array<{ cwd: string; signal: AbortSignal; dispatch: unknown }> = [];
  const fake: PiWorkerCompatibleAdapter = {
    id: "scripted-test",
    version: WORKER_ADAPTER_VERSION,
    async run(task, signal) {
      seen.push({ cwd: task.cwd, signal, dispatch: task.dispatch });
      return successResult();
    },
  };
  const controller = new AbortController();
  const runner = issueWorkerRunnerFromAdapter(fake);

  const result = await runner("/tmp/fake-worktree", "do not spawn Pi", {
    signal: controller.signal,
    issueNumber: 75,
    runId: "fake-run",
    phase: "planning",
    dispatch,
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, "/tmp/fake-worktree");
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].dispatch, dispatch);
});

test("PiWorkerAdapter rejects conflicting controller bindings", async () => {
  let launches = 0;
  const runner: IssueWorkerRunner = async () => {
    launches += 1;
    return successResult();
  };
  const adapter = new PiWorkerAdapter(runner);

  assert.throws(
    () => adapter.run(
      {
        cwd: "/tmp/issue-75",
        prompt: "task",
        issueNumber: 75,
        options: { issueNumber: 76 },
      },
      new AbortController().signal,
    ),
    /conflicting issue bindings/,
  );
  assert.equal(launches, 0);
});

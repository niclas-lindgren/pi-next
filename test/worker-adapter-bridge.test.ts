import assert from "node:assert/strict";
import { test } from "node:test";

import { SdkSessionWorkerAdapter } from "../src/bootstrap/worker-adapter-bridge.ts";
import { WORKER_ADAPTER_VERSION, type WorkerEvent } from "../src/coordination/worker-adapter.ts";
import type { WorkerFactory, WorkerSession } from "../src/bootstrap/types.ts";

function fakeFactory(prompt: (session: { emit: (event: unknown) => void }) => Promise<void>, options: { model?: { provider: string; id: string } } = {}): WorkerFactory {
  return async () => {
    let listener: ((event: unknown) => void) | undefined;
    const session: WorkerSession = {
      model: options.model,
      subscribe: (next) => { listener = next; return () => { if (listener === next) listener = undefined; }; },
      prompt: async () => { await prompt({ emit: (event) => listener?.(event) }); },
      dispose: () => undefined,
    };
    return session;
  };
}

test("adapter exposes a stable id/version", () => {
  const adapter = new SdkSessionWorkerAdapter(fakeFactory(async () => undefined));
  assert.equal(adapter.id, "pi-sdk-session");
  assert.equal(adapter.version, WORKER_ADAPTER_VERSION);
});

test("a normal terminal assistant result maps to ok:true with usage/model telemetry", async () => {
  const factory = fakeFactory(async ({ emit }) => {
    emit({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  }, { model: { provider: "openai-codex", id: "gpt-5.5" } });
  const adapter = new SdkSessionWorkerAdapter(factory);
  const result = await adapter.run({ cwd: "/tmp/fixture", prompt: "do the task" }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.failure, undefined);
  assert.equal(result.telemetry.status, "complete");
  assert.equal(result.telemetry.model, "openai-codex/gpt-5.5");
});

test("the #145/#132 zero-evidence shape maps to ok:false with a typed MODEL_TURN_UNPROVEN failure", async () => {
  const factory = fakeFactory(async () => undefined);
  const adapter = new SdkSessionWorkerAdapter(factory);
  const result = await adapter.run({ cwd: "/tmp/fixture", prompt: "do the task" }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.equal(result.telemetry.status, "unavailable");
  assert.equal(result.failure?.code, "MODEL_TURN_UNPROVEN");
});

test("a terminal provider error maps to ok:false with a typed MODEL_TURN_FAILED failure carrying the error detail", async () => {
  const factory = fakeFactory(async ({ emit }) => {
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" } });
  });
  const adapter = new SdkSessionWorkerAdapter(factory);
  const result = await adapter.run({ cwd: "/tmp/fixture", prompt: "do the task" }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "MODEL_TURN_FAILED");
  assert.match(result.failure?.summary ?? "", /upstream 503/);
});

test("timeout maps to ok:false with a WORKER_TIMEOUT failure code", async () => {
  const factory = fakeFactory(() => new Promise<void>(() => undefined));
  const adapter = new SdkSessionWorkerAdapter(factory);
  const result = await adapter.run({ cwd: "/tmp/fixture", prompt: "do the task", timeoutMs: 10 }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "WORKER_TIMEOUT");
});

test("caller cancellation maps to ok:false with a WORKER_CANCELLED failure code", async () => {
  const controller = new AbortController();
  const factory = fakeFactory(() => new Promise<void>(() => undefined));
  const adapter = new SdkSessionWorkerAdapter(factory);
  const resultPromise = adapter.run({ cwd: "/tmp/fixture", prompt: "do the task", timeoutMs: 5_000 }, controller.signal);
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "WORKER_CANCELLED");
});

test("tool activity forwards through the harness-neutral emit sink", async () => {
  const factory = fakeFactory(async ({ emit }) => {
    emit({ type: "tool_execution_end", toolName: "read" });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  });
  const adapter = new SdkSessionWorkerAdapter(factory);
  const events: WorkerEvent[] = [];
  const result = await adapter.run({ cwd: "/tmp/fixture", prompt: "do the task", phase: "implementation" }, new AbortController().signal, (event) => events.push(event));

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.activity?.toolCalls, 1);
  assert.ok(events.some((event) => event.type === "activity" && event.phase === "implementation"));
});

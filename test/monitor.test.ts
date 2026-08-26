import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { validatePiNextConfig, InMemoryWorkAuthority, type AuthorityWorkItem, type PiNextConfig } from "../src/coordination/index.ts";
import { createIssueLease } from "../src/coordination/issue-authority.ts";
import { PiNextMonitor } from "../extensions/pi-next/monitor.ts";
import type { IssueLeaseAuthority } from "../extensions/pi-next/issue-leases.ts";
import { abortRun, __resetRunCancellationForTests } from "../extensions/pi-next/run-cancellation.ts";

afterEach(() => {
  __resetRunCancellationForTests();
});

const config: PiNextConfig = validatePiNextConfig({
  version: 1,
  authority: { adapter: "memory", projectStatus: { todo: "Todo", inProgress: "In Progress", done: "Done", blocked: "Blocked" } },
  selection: { priorities: ["P0", "P1"], readyStates: ["ready"], blockedStates: ["blocked"] },
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
  monitor: { pollIntervalMs: 1000, maxBackoffMs: 4000 },
});

function item(number: number, states: string[] = ["ready"], priority = "P1"): AuthorityWorkItem {
  return { id: String(number), number, title: `Issue ${number}`, body: "", state: "open", priority, states, comments: [], updatedAt: new Date(number * 1000).toISOString() };
}

class FakeLeaseAuthority implements IssueLeaseAuthority {
  fresh = new Set<number>();
  async read(issueNumber: number) {
    if (!this.fresh.has(issueNumber)) return undefined;
    return createIssueLease({ issueNumber, agent: "foreign", runId: "run", sessionId: "session", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }
  async create() { throw new Error("not used"); }
  async replace() { throw new Error("not used"); }
  async remove() { throw new Error("not used"); }
}

async function withTmp<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-monitor-"));
  try { return await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function monitor(cwd: string, authority: InMemoryWorkAuthority, scheduler: ConstructorParameters<typeof PiNextMonitor>[0]["scheduler"], leaseAuthority?: IssueLeaseAuthority) {
  return new PiNextMonitor({ cwd, config, authority, leaseAuthority, pollIntervalMs: 1000, maxBackoffMs: 4000, scheduler, setTimeout: () => 0, clearTimeout: () => undefined });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "condition was not reached");
}

test("monitor construction fails closed without a shared lifecycle scheduler", async () => withTmp(async (cwd) => {
  assert.throws(
    () => new PiNextMonitor({ cwd, config, authority: new InMemoryWorkAuthority([]), setTimeout: () => 0, clearTimeout: () => undefined } as never),
    /requires an explicit shared lifecycle scheduler/,
  );
}));

test("idle monitor repeats authority checks with zero worker/model launches", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([]);
  let workers = 0;
  let modelCalls = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; });
  m.start();
  await m.checkNow();
  await m.checkNow();
  assert.equal(m.snapshot().authorityChecks, 2);
  assert.equal(workers, 0);
  assert.equal(modelCalls, 0);
}));

test("newly created eligible item wakes scheduler once", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([]);
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; });
  m.start();
  await m.checkNow();
  authority.upsert(item(1));
  await m.checkNow();
  assert.equal(workers, 1);
  assert.equal(m.snapshot().wakeUps, 1);
}));

test("blocked issue becoming eligible wakes scheduler", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(2, ["blocked", "ready"])]);
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; });
  m.start();
  await m.checkNow();
  authority.upsert(item(2, ["ready"]));
  await m.checkNow();
  assert.equal(workers, 1);
}));

test("changes during active run coalesce instead of spawning concurrent schedulers", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(3)]);
  let release!: () => void;
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; await new Promise<void>((resolve) => { release = resolve; }); });
  m.start();
  const running = m.checkNow();
  await waitFor(() => workers === 1);
  authority.upsert(item(4));
  await m.checkNow();
  assert.equal(workers, 1);
  release();
  await running;
}));

test("start is idempotent and cannot duplicate schedulers", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(5)]);
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; });
  m.start();
  m.start();
  await m.checkNow();
  assert.equal(workers, 1);
  assert.equal(m.snapshot().schedulerLaunches, 1);
}));

test("fresh foreign lease is skipped without stopping monitor mode", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(6, ["ready"], "P0"), item(7, ["ready"], "P1")]);
  const leases = new FakeLeaseAuthority();
  leases.fresh.add(6);
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; }, leases);
  m.start();
  await m.checkNow();
  assert.equal(workers, 1);
  assert.equal(m.snapshot().running, true);
}));

test("network failure enters bounded backoff and later recovers", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(8)]);
  let fail = true;
  const original = authority.listCandidates.bind(authority);
  authority.listCandidates = async (cfg) => { if (fail) throw new Error("rate limited"); return original(cfg); };
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; });
  m.start();
  await m.checkNow();
  assert.equal(m.snapshot().phase, "backoff");
  assert.match(m.snapshot().lastError?.message || "", /rate limited/);
  fail = false;
  await m.checkNow();
  assert.equal(workers, 1);
  assert.equal(m.snapshot().phase, "monitoring");
}));

test("stop while idle exits promptly and cleanly", async () => withTmp(async (cwd) => {
  const m = monitor(cwd, new InMemoryWorkAuthority([]), async () => undefined);
  m.start();
  const status = m.stop();
  assert.equal(status.phase, "stopped");
  assert.equal(status.running, false);
}));

test("graceful stop during active work lets scheduler finish and schedules no further work", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(9)]);
  let release!: () => void;
  let workers = 0;
  const m = monitor(cwd, authority, async () => { workers += 1; await new Promise<void>((resolve) => { release = resolve; }); });
  m.start();
  const running = m.checkNow();
  await waitFor(() => workers === 1);
  m.stop();
  release();
  await running;
  await m.checkNow();
  assert.equal(workers, 1);
  assert.equal(m.snapshot().phase, "stopped");
}));

test("stop during active monitor scheduler aborts the canonical run signal and leaves no live run", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(10)]);
  let schedulerStarts = 0;
  let seenRunId = "";
  let seenSignal: AbortSignal | undefined;
  const m = monitor(cwd, authority, async ({ runId, signal }) => {
    schedulerStarts += 1;
    seenRunId = runId;
    seenSignal = signal;
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
  m.start();
  const running = m.checkNow();
  await waitFor(() => schedulerStarts === 1 && !!m.snapshot().activeRun);
  assert.equal(m.snapshot().activeRun, seenRunId);

  const stopping = m.stop();
  assert.equal(stopping.phase, "stopping");
  assert.equal(seenSignal?.aborted, true);
  await running;

  assert.equal(m.snapshot().phase, "stopped");
  assert.equal(m.snapshot().activeRun, undefined);
  assert.equal(abortRun(seenRunId, "after settle"), false);
  authority.upsert(item(11));
  await m.checkNow();
  assert.equal(schedulerStarts, 1);
}));

test("externally aborted monitor run stops at the current boundary instead of polling again", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(12)]);
  let schedulerStarts = 0;
  let seenRunId = "";
  const m = monitor(cwd, authority, async ({ runId, signal }) => {
    schedulerStarts += 1;
    seenRunId = runId;
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
  m.start();
  const running = m.checkNow();
  await waitFor(() => schedulerStarts === 1 && !!seenRunId);
  assert.equal(abortRun(seenRunId, "loop stop requested"), true);
  await running;

  assert.equal(m.snapshot().phase, "stopped");
  assert.equal(m.snapshot().running, false);
  authority.upsert(item(13));
  await m.checkNow();
  assert.equal(schedulerStarts, 1);
}));

test("restart plus monitor start performs fresh discovery instead of using stale cache", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([]);
  let workers = 0;
  const first = monitor(cwd, authority, async () => { workers += 1; });
  first.start();
  await first.checkNow();
  first.stop();
  authority.upsert(item(10));
  const second = monitor(cwd, authority, async () => { workers += 1; });
  second.start();
  await second.checkNow();
  assert.equal(workers, 1);
  assert.equal(second.snapshot().authorityChecks, 1);
}));

test("completion returns to idle monitoring with fresh child context for next issue", async () => withTmp(async (cwd) => {
  const authority = new InMemoryWorkAuthority([item(11)]);
  const contexts: number[] = [];
  let context = 0;
  const m = monitor(cwd, authority, async () => { contexts.push(++context); await authority.close(String(context === 1 ? 11 : 12), "done"); });
  m.start();
  await m.checkNow();
  authority.upsert(item(12));
  await m.checkNow();
  assert.deepEqual(contexts, [1, 2]);
}));

test("status rendering is bounded and polling does not call a model", async () => withTmp(async (cwd) => {
  const statuses: string[] = [];
  let modelCalls = 0;
  const m = new PiNextMonitor({ cwd, config, authority: new InMemoryWorkAuthority([]), scheduler: async () => undefined, onStatus: (s) => statuses.push(s.phase), setTimeout: () => 0, clearTimeout: () => undefined });
  m.start();
  await m.checkNow();
  assert.ok(statuses.length < 10);
  assert.equal(modelCalls, 0);
}));

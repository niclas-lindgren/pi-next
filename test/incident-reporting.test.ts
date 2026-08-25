import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyIncident,
  computeIncidentFingerprint,
  createControllerIdentityMismatchIncident,
  createIncidentBundle,
  incidentBundleFromLifecycleResult,
  persistIncidentBundle,
  publishIncidentToGithub,
  readLastIncidentBundle,
  reportIncidentBundle,
  runCoordinationCli,
  type IncidentGithubAuthority,
  type IncidentReportTargetIssue,
} from "../src/coordination/index.ts";
import type { BootstrapReport } from "../src/bootstrap/types.ts";
import type { UnifiedLifecycleResult } from "../src/lifecycle/index.ts";
import { renderLoopStatus } from "../extensions/pi-next/loop-status.ts";
import { reportIdentityMismatch } from "../extensions/pi-next/loop.ts";
import { emptyLoopMetrics, type LoopState } from "../extensions/pi-next/loop-state.ts";

function loopState(runId: string, overrides: Partial<LoopState> = {}): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    sessionId: "session-a",
    requestedIssues: 1,
    remainingIssues: 1,
    step: 1,
    settledStep: 0,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
    metrics: emptyLoopMetrics(),
    ...overrides,
  };
}

async function persistLoopState(cwd: string, value: LoopState, lock?: string): Promise<void> {
  const dir = join(cwd, ".pi", "runtime", "pi-next-loops", value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(value));
  if (lock !== undefined) await writeFile(join(dir, "controller.lock"), lock);
}

class FakeIncidentAuthority implements IncidentGithubAuthority {
  comments: { repository: string; issueNumber: number; body: string }[] = [];
  creates: { repository: string; title: string; body: string; labels?: string[] }[] = [];
  constructor(public matches: IncidentReportTargetIssue[] = [], private readonly fail = false) {}
  async searchFingerprint(): Promise<IncidentReportTargetIssue[]> {
    if (this.fail) throw new Error("network failed ghp_secret sk-secret");
    return this.matches;
  }
  async appendOccurrence(repository: string, issueNumber: number, body: string): Promise<{ url?: string }> {
    this.comments.push({ repository, issueNumber, body });
    return { url: `https://example.test/${issueNumber}` };
  }
  async createIssue(repository: string, title: string, body: string, labels?: string[]): Promise<{ number?: number; url?: string }> {
    this.creates.push({ repository, title, body, labels });
    return { number: 900, url: "https://example.test/900" };
  }
}

async function withTemp(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-next-incident-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function frameworkBundle(reason = "UNKNOWN_CHANGES: untracked directory path collapse at issue #81 sha abcdef1234567890"): ReturnType<typeof createIncidentBundle> {
  return createIncidentBundle({
    cwd: process.cwd(),
    failure: {
      subsystem: "bootstrap-finalizer",
      phase: "finalization",
      code: "UNKNOWN_CHANGES",
      reason,
      invariant: "untracked directory path collapse",
      boundary: "pi-next",
    },
    lifecycle: { entry: "bootstrap", runId: "run-1", issueNumber: 81, phase: "finalization", disposition: "finalization-blocked", implementation: "PASS", verification: "PASS", finalization: "BLOCKED", workerAttempts: [{ role: "implementation", disposition: "completed", toolCalls: 0 }] },
    candidate: { head: "a".repeat(40), baseline: "b".repeat(40), mergeBase: "c".repeat(40), originMain: "d".repeat(40), aheadOfOriginMain: 1, behindOriginMain: 0, dirty: true, stagedFiles: ["src/a.ts"], unstagedFiles: ["src/b.ts"], untrackedFiles: ["tmp/new-file.txt"] },
    checks: [{ command: "npm test", exitCode: 0, durationMs: 12 }, { command: "npm run typecheck", exitCode: 1, snippet: "Bearer ghp_secret and sk-secret should redact" }],
    lock: { owner: "run-1", phase: "finalization", token: "should be omitted" },
    authority: { authorityFingerprint: "auth", issueBody: "should be omitted" },
    checkpoints: [{ version: 1, sequence: 1, at: "2026-01-01T00:00:00.000Z", runId: "run-1", issueNumber: 81, event: "worker_finished", payload: { phase: "worker" } }],
  });
}

test("incident classification is conservative for worker, consumer, transient, and framework failures", () => {
  assert.equal(classifyIncident({ subsystem: "worker", phase: "verification", code: "CHECK_FAILED", reason: "npm test failed", boundary: "worker" }).reportability, "not-reportable");
  assert.equal(classifyIncident({ subsystem: "consumer-config", phase: "preflight", code: "invalid_pi_next_config", boundary: "consumer" }).category, "consumer-config");
  assert.equal(classifyIncident({ subsystem: "provider", phase: "worker", code: "RATE_LIMIT", reason: "provider timeout", boundary: "provider" }).reportability, "not-reportable");
  assert.deepEqual(classifyIncident({ subsystem: "bootstrap-finalizer", phase: "finalization", code: "UNKNOWN_CHANGES", boundary: "pi-next" }), {
    category: "framework",
    reportability: "upstream",
    reason: "typed pi-next framework/controller invariant failure",
  });
});

test("stable equivalent framework failures share fingerprints while broad codes keep distinct roots", () => {
  const first = computeIncidentFingerprint({ subsystem: "bootstrap-finalizer", phase: "finalization", code: "UNKNOWN_CHANGES", invariant: "untracked directory path collapse", reason: "issue #81 sha aaaaaaa" });
  const second = computeIncidentFingerprint({ subsystem: "bootstrap-finalizer", phase: "finalization", code: "UNKNOWN_CHANGES", invariant: "untracked directory path collapse", reason: "issue #141 sha bbbbbbb" });
  assert.equal(first, second);
  const broadA = computeIncidentFingerprint({ subsystem: "bootstrap", phase: "worker", code: "BOOTSTRAP_FAILED", reason: "gh json field missing" });
  const broadB = computeIncidentFingerprint({ subsystem: "bootstrap", phase: "worker", code: "BOOTSTRAP_FAILED", reason: "candidate branch unreachable" });
  assert.notEqual(broadA, broadB);
});

test("bundle contains bounded metadata and excludes secrets prompts transcripts and issue bodies", () => {
  const bundle = frameworkBundle();
  assert.equal(bundle.runtime.node, process.version);
  assert.equal(bundle.lifecycle?.phase, "finalization");
  assert.equal(bundle.failure.code, "UNKNOWN_CHANGES");
  assert.equal(bundle.candidate?.untrackedFiles?.[0], "tmp/new-file.txt");
  assert.equal(bundle.checks?.[1]?.exitCode, 1);
  assert.equal(bundle.lock?.owner, "run-1");
  assert.equal(bundle.checkpoints?.[0]?.event, "worker_finished");
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /ghp_secret|sk-secret|should be omitted|issueBody|token|prompt|transcript/i);
  assert.match(serialized, /REDACTED/);
});

test("github dedupe appends open occurrence, follows up closed match, and refuses ambiguous matches", async () => {
  const bundle = frameworkBundle();
  const open = new FakeIncidentAuthority([{ number: 10, state: "OPEN", url: "https://example.test/10" }]);
  assert.equal((await publishIncidentToGithub(bundle, { repository: "owner/repo", authority: open })).status, "commented");
  assert.equal(open.comments.length, 1);
  assert.equal(open.creates.length, 0);
  assert.match(open.comments[0]!.body, /pi-next-incident-fingerprint/);

  const closed = new FakeIncidentAuthority([{ number: 11, state: "CLOSED", url: "https://example.test/11" }]);
  const created = await publishIncidentToGithub(bundle, { repository: "owner/repo", authority: closed });
  assert.equal(created.status, "created");
  assert.equal(closed.creates.length, 1);
  assert.match(closed.creates[0]!.body, /Regression follow-up/);

  const ambiguous = new FakeIncidentAuthority([{ number: 12, state: "OPEN" }, { number: 13, state: "OPEN" }]);
  const result = await publishIncidentToGithub(bundle, { repository: "owner/repo", authority: ambiguous });
  assert.equal(result.status, "ambiguous");
  assert.equal(ambiguous.comments.length + ambiguous.creates.length, 0);
});

test("github reporting failure leaves local incident state intact", async () => {
  await withTemp(async (dir) => {
    const bundle = frameworkBundle();
    const result = await reportIncidentBundle(dir, bundle, { github: true, authority: new FakeIncidentAuthority([], true) });
    assert.equal(result.github?.status, "failed");
    assert.deepEqual(readLastIncidentBundle(dir)?.fingerprint, bundle.fingerprint);
    const text = await readFile(result.local.path, "utf8");
    assert.match(text, new RegExp(bundle.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(JSON.stringify(result.github), /ghp_secret|sk-secret/);
  });
});

test("explicit report --last works when automatic github reporting is disabled", async () => {
  await withTemp(async (dir) => {
    await writeFile(join(dir, ".pi-next-placeholder"), "", "utf8");
    const bundle = frameworkBundle();
    persistIncidentBundle(dir, bundle);
    const result = await runCoordinationCli(["report", "--last", "--cwd", dir]);
    assert.equal(result.ok, true);
    assert.equal(result.command, "report");
    assert.equal((result as { fingerprint?: string }).fingerprint, bundle.fingerprint);
    assert.equal((result as { github?: unknown }).github, undefined);
  });
});

test("controller/footer identity mismatch is captured as reportable framework incident", () => {
  const bundle = createControllerIdentityMismatchIncident({ activeIssue: 647, activeRunId: "run-active", footerIssue: 646, footerRunId: "run-old" });
  assert.equal(bundle.classification.reportability, "upstream");
  assert.equal(bundle.failure.code, "CONTROLLER_IDENTITY_MISMATCH");
  assert.equal(bundle.identityMismatch?.footerIssue, 646);
});

test("a real Campsty #647/#640-shape status contradiction is automatically persisted and retrievable via report --last, without the test constructing the bundle itself (#145)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-identity-mismatch-report-"));
  try {
    // Reproduce the production wiring: renderLoopStatus detects the
    // contradiction and hands only raw run/issue identities to the reporter
    // (loop.ts's reportIdentityMismatch) - the same call path a real
    // `/pi-next-loop status` invocation takes, not a hand-built bundle.
    await persistLoopState(cwd, loopState("run-640", { activeIssueNumber: 640 }), "run_id=run-640\npid=101\n");
    await persistLoopState(cwd, loopState("run-647", { activeIssueNumber: 647 }));
    const mismatches: Parameters<typeof reportIdentityMismatch>[1][] = [];
    renderLoopStatus(cwd, "session-a", undefined, "summary", {
      processAlive: (pid) => pid === 101,
      authoritativeRunId: "run-647",
      onIdentityMismatch: (details) => mismatches.push(details),
    });
    assert.equal(mismatches.length, 1);

    reportIdentityMismatch(cwd, mismatches[0]!);

    const last = readLastIncidentBundle(cwd);
    assert.ok(last, "report --last must retrieve the automatically persisted bundle");
    assert.equal(last!.failure.code, "CONTROLLER_IDENTITY_MISMATCH");
    assert.equal(last!.identityMismatch?.activeIssue, 647);
    assert.equal(last!.identityMismatch?.activeRunId, "run-647");
    assert.equal(last!.identityMismatch?.footerIssue, 640);
    assert.equal(last!.identityMismatch?.footerRunId, "run-640");

    const bySpecificIssue = readLastIncidentBundle(cwd, 647);
    assert.equal(bySpecificIssue?.failure.code, "CONTROLLER_IDENTITY_MISMATCH");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repeated identity-mismatch status polls against the same unresolved contradiction do not spam a fresh incident file per call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-identity-mismatch-debounce-"));
  try {
    const details = { activeIssue: 647, activeRunId: "run-647", footerIssue: 640, footerRunId: "run-640", reason: "authoritative live run run-647 disagrees with footer-selected run run-640" };
    reportIdentityMismatch(cwd, details);
    const first = readLastIncidentBundle(cwd);
    reportIdentityMismatch(cwd, details);
    const second = readLastIncidentBundle(cwd);
    assert.equal(first?.createdAt, second?.createdAt, "an identical unresolved mismatch must not persist a second bundle");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function bootstrapReport(): BootstrapReport {
  return {
    issueNumber: 145,
    attempts: 1,
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-01T00:00:01.000Z",
    disposition: "pass",
    branch: "agent/issue-145",
    worktree: "/tmp/issue-145",
    revision: "a".repeat(40),
    baselineRevision: "b".repeat(40),
    candidate: {
      headRevision: "a".repeat(40),
      baselineRevision: "b".repeat(40),
      originMainRevision: "c".repeat(40),
      mergeBaseRevision: "d".repeat(40),
      dirty: false,
      changedFiles: ["src/index.ts"],
      committedChanges: true,
      uncommittedChanges: false,
      committedFiles: ["src/index.ts"],
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      commitsAheadOfMergeBase: 1,
      commitsAheadOfOriginMain: 1,
      commitsBehindOriginMain: 0,
      behindOriginMain: false,
      divergedFromOriginMain: false,
    },
    dependencySetup: { action: "not-required" },
    workerAttempts: [{ role: "implementation", disposition: "completed", durationMs: 1, toolCalls: 0, terminalResultObserved: true }],
    checks: [{ command: "npm test", exitCode: 0, durationMs: 1, passed: true }],
    mechanicalPass: true,
    candidateReadyForReview: true,
    finalizationReady: true,
    implementationOutcome: "implemented",
    candidateHasDelta: true,
  };
}

test("lifecycle finalizer invariant creates reportable bundle while ordinary check failure does not", () => {
  const finalizer: UnifiedLifecycleResult = {
    issueNumber: 145,
    runId: "run-finalizer",
    entry: "bootstrap",
    disposition: "finalization-blocked",
    implementation: "PASS",
    verification: "PASS",
    finalization: "BLOCKED",
    candidatePreserved: true,
    implementationReport: bootstrapReport(),
    finalizationFailure: { code: "UNKNOWN_CHANGES", reason: "untracked directory path collapse at sha aaaaaaa" },
    projection: { activeIssue: 145, runId: "run-finalizer", phase: "terminal", workerLive: false, terminalDisposition: "finalization-blocked" },
  };
  const bundle = incidentBundleFromLifecycleResult(process.cwd(), finalizer);
  assert.equal(bundle?.classification.reportability, "upstream");
  assert.equal(bundle?.candidate?.committedFiles?.[0], "src/index.ts");

  const ordinaryReport = { ...bootstrapReport(), disposition: "repairable-failure" as const, mechanicalPass: false, failureReason: "npm test failed", implementationOutcome: "failed" as const };
  const ordinary: UnifiedLifecycleResult = { ...finalizer, disposition: "repairable-failure", implementation: "FAIL", verification: "FAIL", finalization: "SKIPPED", implementationReport: ordinaryReport, finalizationFailure: undefined };
  const ordinaryBundle = incidentBundleFromLifecycleResult(process.cwd(), ordinary);
  assert.equal(ordinaryBundle?.classification.reportability, "not-reportable");
});

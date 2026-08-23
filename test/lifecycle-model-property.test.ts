import assert from "node:assert/strict";
import { test } from "node:test";

import fc, { type AsyncCommand } from "fast-check";

import { runBootstrap } from "../src/bootstrap/supervisor.ts";
import type { CommandRunner, WorkerFactory } from "../src/bootstrap/types.ts";

import {
  authorityFingerprint,
  claimIssueLease,
  ensureIssueWorktree,
  finalizeIssue,
  InMemoryWorkAuthority,
  LeaseConflictError,
  type AuthorityWorkItem,
} from "../src/coordination/index.ts";
import { LifecycleCheckpointFault, withLifecycleFaultInjection } from "../src/coordination/lifecycle-checkpoints.ts";
import { cleanupCompletedIssueWorktree } from "../extensions/pi-next/main-refresh.ts";
import { ScriptedWorkerAdapter } from "../src/evaluation/scripted-worker-adapter.ts";
import {
  createDisposableGitFixture,
  type DisposableGitFixture,
} from "./helpers/git-fixture.ts";
import {
  ManualScenarioClock,
  MemoryIssueLeaseAuthority,
} from "./helpers/lifecycle-scenario.ts";

const ISSUE = 7901;
const OTHER_ISSUE = 7902;
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const FOREIGN = "foreign";

type WorkState = "open" | "active" | "pending-verification" | "completed";
type LeaseState = "none" | "ours" | "foreign-fresh" | "stale";
type WorkspaceState = "absent" | "canonical-clean" | "canonical-dirty" | "ambiguous";
type CandidateState = "none" | "local" | "committed" | "integrated";
type VerificationState = "none" | "pass" | "fail" | "stale";
type AuthorityState = "unchanged" | "changed";

interface LifecycleModel {
  work: WorkState;
  lease: LeaseState;
  workspace: WorkspaceState;
  candidate: CandidateState;
  verification: VerificationState;
  authority: AuthorityState;
  owner: typeof OWNER_A | typeof OWNER_B;
  workerActive: boolean;
  preflightFailed: boolean;
  closed: boolean;
  pendingRecorded: boolean;
  integratedReachable: boolean;
  cleanupDeletedUnique: boolean;
  unrelatedClaimBlocked: boolean;
  duplicateTerminalSideEffect: boolean;
  workerLaunches: number;
  closeWasAuthorized: boolean;
  staleMutationSucceeded: boolean;
  cleanupRanBeforeReachability: boolean;
  trace: string[];
}

interface RealLifecycle {
  git: DisposableGitFixture;
  leases: MemoryIssueLeaseAuthority;
  authority: InMemoryWorkAuthority;
  clock: ManualScenarioClock;
  worker: ScriptedWorkerAdapter;
  activeWorker?: { controller: AbortController; result: Promise<unknown> };
  worktree?: string;
  candidateSha?: string;
  verifiedFingerprint?: string;
  verifiedIntegratedMain?: string;
  terminalAttempts: number;
}

function leaseInput(issueNumber: number, runId: string, clock: ManualScenarioClock) {
  return {
    issueNumber,
    agent: "pi-next",
    runId,
    sessionId: `${runId}-session`,
    acquiredAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 30 * 60_000).toISOString(),
  } as const;
}

function item(issueNumber: number): AuthorityWorkItem {
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: `Issue ${issueNumber}`,
    body: "initial requirement",
    state: "open",
    updatedAt: "2026-08-22T12:00:00.000Z",
    priority: "P1",
    states: ["Todo"],
    comments: [],
  };
}

function initialModel(): LifecycleModel {
  return {
    work: "open",
    lease: "none",
    workspace: "absent",
    candidate: "none",
    verification: "none",
    authority: "unchanged",
    owner: OWNER_A,
    workerActive: false,
    preflightFailed: false,
    closed: false,
    pendingRecorded: false,
    integratedReachable: false,
    cleanupDeletedUnique: false,
    unrelatedClaimBlocked: false,
    duplicateTerminalSideEffect: false,
    workerLaunches: 0,
    closeWasAuthorized: false,
    staleMutationSucceeded: false,
    cleanupRanBeforeReachability: false,
    trace: [],
  };
}

async function createReal(): Promise<RealLifecycle> {
  const git = await createDisposableGitFixture({
    prefix: "pi-next-lifecycle-model-",
    withOrigin: true,
    initialFiles: { "README.md": "fixture\n", ".gitignore": ".worktrees/\n" },
  });
  return {
    git,
    leases: new MemoryIssueLeaseAuthority(),
    authority: new InMemoryWorkAuthority([item(ISSUE), item(OTHER_ISSUE)]),
    clock: new ManualScenarioClock(),
    worker: new ScriptedWorkerAdapter([{ behavior: "success" }, { behavior: "success" }, { behavior: "success" }]),
    terminalAttempts: 0,
  };
}

function modelSnapshot(m: LifecycleModel): string {
  const { trace, ...bounded } = m;
  return JSON.stringify({ ...bounded, trace: trace.join(" -> ") });
}

async function realSnapshot(r: RealLifecycle): Promise<string> {
  const live = await r.leases.read(ISSUE);
  const other = await r.leases.read(OTHER_ISSUE);
  const liveItem = await r.authority.get(String(ISSUE));
  let status = "absent";
  if (r.worktree) {
    try {
      status = await r.git.git(r.worktree, "status", "--porcelain=v1", "--untracked-files=all");
    } catch {
      status = "missing";
    }
  }
  return JSON.stringify({
    lease: live?.runId,
    leaseExpiresAt: live?.expiresAt,
    otherLease: other?.runId,
    workState: liveItem.state,
    comments: liveItem.comments.length,
    pending: Boolean(liveItem.pendingVerification),
    candidateSha: r.candidateSha,
    worktreeStatus: status,
  });
}

async function invariant(m: LifecycleModel, r: RealLifecycle, condition: unknown, message: string): Promise<void> {
  if (condition) return;
  throw new Error(`${message}\nmodel=${modelSnapshot(m)}\nreal=${await realSnapshot(r)}`);
}

function failingPreflightRunner(): CommandRunner {
  return async (command, args, options) => ({
    command,
    args,
    cwd: options.cwd,
    exitCode: 1,
    stdout: "",
    stderr: "static preflight failed",
    durationMs: 0,
  });
}

function countingBootstrapWorkerFactory(counter: { launches: number }): WorkerFactory {
  return async () => {
    counter.launches += 1;
    return {
      async prompt() {},
      subscribe() { return () => {}; },
      dispose() {},
    };
  };
}

async function assertCoreInvariants(m: LifecycleModel, r: RealLifecycle): Promise<void> {
  const live = await r.leases.read(ISSUE);
  const freshOwners = live && Date.parse(live.expiresAt) > r.clock.now().getTime() ? [live.runId] : [];
  await invariant(m, r, freshOwners.length <= 1, "core invariant 1 violated: at most one fresh authoritative owner");

  await invariant(m, r, !m.staleMutationSucceeded, "core invariant 2 violated: foreign/stale worker mutated or closed after ownership loss");

  await invariant(
    m,
    r,
    !m.closed || m.closeWasAuthorized,
    "core invariant 3 violated: issue closed without current authority and required verification",
  );
  await invariant(
    m,
    r,
    m.candidate !== "integrated" || (m.verification === "pass" && m.workspace !== "ambiguous"),
    "core invariant 4 violated: unverified or ambiguous candidate promoted",
  );
  await invariant(m, r, !m.cleanupDeletedUnique, "core invariant 5 violated: unique dirty/unintegrated work was deleted");
  await invariant(m, r, !m.unrelatedClaimBlocked, "core invariant 6 violated: candidate-local race globally blocked unrelated work");
  await invariant(m, r, !m.duplicateTerminalSideEffect, "core invariant 7 violated: durable restart/retry duplicated a terminal side effect");
  await invariant(m, r, !(m.pendingRecorded && m.closed), "core invariant 8 violated: pending external verification became false PASS/Done");
  await invariant(m, r, !(m.preflightFailed && m.workerLaunches > 0), "core invariant 9 violated: static preflight failure launched workers");
  await invariant(m, r, !m.cleanupRanBeforeReachability && (!m.closed || m.integratedReachable), "core invariant 10 violated: cleanup/close happened before reachability");
}

abstract class LifecycleCommand implements AsyncCommand<LifecycleModel, RealLifecycle> {
  abstract check(m: Readonly<LifecycleModel>): boolean;
  abstract run(m: LifecycleModel, r: RealLifecycle): Promise<void>;
  protected async done(m: LifecycleModel, r: RealLifecycle, name: string): Promise<void> {
    m.trace.push(name);
    await assertCoreInvariants(m, r);
  }
}

class DiscoverSelectCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.work === "open"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const candidates = await r.authority.listCandidates({ selection: { priorities: ["P1"] } } as never);
    await invariant(m, r, candidates.some((candidate) => candidate.number === ISSUE), "discover/select lost the open issue");
    await this.done(m, r, this.toString());
  }
  toString() { return "discoverSelect()"; }
}

class ClaimCommand extends LifecycleCommand {
  constructor(private readonly owner: typeof OWNER_A | typeof OWNER_B) { super(); }
  check(m: Readonly<LifecycleModel>) { return m.work !== "completed" && (m.lease === "none" || m.lease === "stale"); }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const lease = await claimIssueLease(r.leases, leaseInput(ISSUE, this.owner, r.clock), r.clock.now());
    m.lease = "ours";
    m.owner = this.owner;
    assert.equal(lease.runId, this.owner);
    await this.done(m, r, this.toString());
  }
  toString() { return `claim(${this.owner})`; }
}

class LoseRaceCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "none"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const foreign = await claimIssueLease(r.leases, leaseInput(ISSUE, FOREIGN, r.clock), r.clock.now());
    await assert.rejects(() => claimIssueLease(r.leases, leaseInput(ISSUE, m.owner, r.clock), r.clock.now()), LeaseConflictError);
    m.lease = "foreign-fresh";
    assert.equal(foreign.runId, FOREIGN);
    await this.done(m, r, this.toString());
  }
  toString() { return "loseRace(foreign)"; }
}

class ExpireCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" || m.lease === "foreign-fresh"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    r.clock.advance(31 * 60_000);
    m.lease = "stale";
    await this.done(m, r, this.toString());
  }
  toString() { return "expireLease()"; }
}

class PrepareWorkspaceCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" && m.workspace === "absent"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const lease = await r.leases.read(ISSUE);
    r.worktree = await ensureIssueWorktree(r.git.repo, ISSUE, undefined, { ownership: { lease: lease!, authority: r.leases } });
    m.workspace = "canonical-clean";
    await this.done(m, r, this.toString());
  }
  toString() { return "prepareWorkspace()"; }
}

class MakeDirtyCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.workspace === "canonical-clean" && m.candidate !== "integrated"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    await r.git.write(r.worktree!, "unique.txt", `unique ${m.trace.length}\n`);
    m.workspace = "canonical-dirty";
    m.candidate = "local";
    await this.done(m, r, this.toString());
  }
  toString() { return "makeUniqueDirtyWork()"; }
}

class StaticPreflightFailCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" && !m.workerActive && m.workerLaunches === 0; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const launched = { launches: 0 };
    await assert.rejects(() => runBootstrap({ issueNumber: ISSUE, cwd: r.git.repo, allowRepair: false, review: false, timeoutMs: 1 }, {
      runCommand: failingPreflightRunner(),
      createWorker: countingBootstrapWorkerFactory(launched),
      fetchIssue: async () => ({ number: ISSUE, title: "Issue", body: "body", comments: [], state: "OPEN" }),
    }));
    m.preflightFailed = true;
    m.workerLaunches += launched.launches;
    await this.done(m, r, this.toString());
  }
  toString() { return "staticPreflightFail()"; }
}

class StartWorkerCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" && m.workspace !== "absent" && !m.workerActive && !m.preflightFailed; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const controller = new AbortController();
    const liveWorker = new ScriptedWorkerAdapter([{ behavior: "wait-for-cancel" }]);
    r.activeWorker = {
      controller,
      result: liveWorker.run({ cwd: r.worktree!, prompt: "scripted", issueNumber: ISSUE, runId: m.owner, phase: "implementation" }, controller.signal),
    };
    m.workerLaunches += 1;
    m.workerActive = true;
    m.work = "active";
    await this.done(m, r, this.toString());
  }
  toString() { return `startWorker(${OWNER_A}/${OWNER_B})`; }
}

class FinishWorkerCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.workerActive && m.lease === "ours"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    r.activeWorker?.controller.abort();
    await r.activeWorker?.result;
    r.activeWorker = undefined;
    await r.git.write(r.worktree!, "candidate.txt", `candidate after ${m.trace.length}\n`);
    m.workerActive = false;
    m.workspace = "canonical-dirty";
    m.candidate = "local";
    await this.done(m, r, this.toString());
  }
  toString() { return "finishWorkerWithLocalCandidate()"; }
}

class FailOrCancelWorkerCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.workerActive; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    r.activeWorker?.controller.abort();
    await r.activeWorker?.result;
    r.activeWorker = undefined;
    m.workerActive = false;
    m.work = "open";
    await this.done(m, r, this.toString());
  }
  toString() { return "failOrCancelWorker()"; }
}

class StaleWorkerMutationAttemptCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.workerActive && m.lease !== "ours" && m.workspace !== "absent"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const before = await r.authority.get(String(ISSUE));
    const beforeHead = await r.git.git(r.git.repo, "rev-parse", "refs/remotes/origin/main");
    try {
      await finalizeIssue(r.leases, r.authority, {
        cwd: r.git.repo,
        issueNumber: ISSUE,
        agent: "pi-next",
        runId: m.owner,
        sessionId: `${m.owner}-session`,
        issueUpdatedAt: "2026-08-22T12:00:00.000Z",
        candidateSha: r.candidateSha ?? beforeHead,
        verifiedAuthorityFingerprint: r.verifiedFingerprint ?? authorityFingerprint(before),
      });
    } catch {
      // Expected: the production finalizer rejects stale/foreign ownership before mutation/close.
    }
    const after = await r.authority.get(String(ISSUE));
    const afterHead = await r.git.git(r.git.repo, "rev-parse", "refs/remotes/origin/main");
    m.staleMutationSucceeded = before.state !== after.state || before.comments.length !== after.comments.length || beforeHead !== afterHead;
    r.activeWorker?.controller.abort();
    await r.activeWorker?.result;
    r.activeWorker = undefined;
    m.workerActive = false;
    await this.done(m, r, this.toString());
  }
  toString() { return "staleWorkerMutationAttempt()"; }
}

class AuthorityChangeCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.work !== "completed" && m.authority === "unchanged"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const live = await r.authority.get(String(ISSUE));
    r.authority.upsert({ ...live, body: `${live.body}\nchanged`, updatedAt: "2026-08-22T12:01:00.000Z" });
    m.authority = "changed";
    if (m.verification === "pass") m.verification = "stale";
    await this.done(m, r, this.toString());
  }
  toString() { return "authorityChanged()"; }
}

class CommitCandidateCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" && m.candidate === "local" && m.workspace === "canonical-dirty"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    r.candidateSha = await r.git.commit(r.worktree!, `candidate for #${ISSUE}`);
    m.candidate = "committed";
    m.workspace = "canonical-clean";
    m.verification = "none";
    await this.done(m, r, this.toString());
  }
  toString() { return "commitCandidate()"; }
}

class VerifyPassCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.candidate === "committed" && m.lease === "ours"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const live = await r.authority.get(String(ISSUE));
    r.verifiedFingerprint = authorityFingerprint(live);
    r.verifiedIntegratedMain = undefined;
    m.verification = "pass";
    await this.done(m, r, this.toString());
  }
  toString() { return "verifyPass()"; }
}

class VerifyFailCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.candidate === "committed"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    r.verifiedFingerprint = undefined;
    m.verification = "fail";
    await this.done(m, r, this.toString());
  }
  toString() { return "verifyFail()"; }
}

class PromoteCloseCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.candidate === "committed"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const before = await r.authority.get(String(ISSUE));
    try {
      const result = await finalizeIssue(r.leases, r.authority, {
        cwd: r.git.repo,
        issueNumber: ISSUE,
        agent: "pi-next",
        runId: m.owner,
        sessionId: `${m.owner}-session`,
        issueUpdatedAt: "2026-08-22T12:00:00.000Z",
        candidateSha: r.candidateSha!,
        verifiedAuthorityFingerprint: r.verifiedFingerprint ?? "",
        verifiedIntegratedMain: r.verifiedIntegratedMain ?? "",
      });
      if (result.ok) {
        m.candidate = "integrated";
        m.integratedReachable = true;
        if (result.closed) {
          m.closed = true;
          m.closeWasAuthorized = m.authority === "unchanged" && m.verification === "pass" && m.lease === "ours";
          m.work = "completed";
        }
        if (result.authorityChanged || result.leaseLostAfterMerge || result.requiresReverification) {
          m.verification = "stale";
        }
      }
    } catch {
      // Unsafe attempts must be fail-closed. The model expects no close and no mutation.
    }
    const after = await r.authority.get(String(ISSUE));
    if (m.verification !== "pass" || m.authority !== "unchanged" || m.lease !== "ours") {
      await invariant(m, r, before.state === after.state, "unsafe promote/close mutated authority");
    }
    await this.done(m, r, this.toString());
  }
  toString() { return "promoteAndClose()"; }
}

class PendingVerificationCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.candidate === "committed" && m.verification === "pass" && m.lease === "ours"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const result = await finalizeIssue(r.leases, r.authority, {
      cwd: r.git.repo,
      issueNumber: ISSUE,
      agent: "pi-next",
      runId: m.owner,
      sessionId: `${m.owner}-session`,
      issueUpdatedAt: "2026-08-22T12:00:00.000Z",
      candidateSha: r.candidateSha!,
      verifiedAuthorityFingerprint: r.verifiedFingerprint ?? "",
      pendingVerification: {
        criteria: [{ id: "external", description: "External environment check", environment: "manual-staging" }],
      },
    });
    m.candidate = "integrated";
    m.integratedReachable = true;
    m.pendingRecorded = Boolean(result.pendingVerification);
    m.work = "pending-verification";
    await this.done(m, r, this.toString());
  }
  toString() { return "recordPendingVerification()"; }
}

class ReleaseCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const live = await r.leases.read(ISSUE);
    if (live) await r.leases.remove(ISSUE, live);
    m.lease = "none";
    await this.done(m, r, this.toString());
  }
  toString() { return "releaseLease()"; }
}

class CrashResumeCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.lease === "ours" && m.workspace !== "ambiguous"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const live = await r.leases.read(ISSUE);
    if (r.worktree && live) {
      const resumed = await ensureIssueWorktree(r.git.repo, ISSUE, undefined, { ownership: { lease: live, authority: r.leases } });
      assert.equal(resumed, r.worktree);
    }
    if (m.candidate === "committed" && m.verification === "pass" && m.authority === "unchanged") {
      const commentsBefore = (await r.authority.get(String(ISSUE))).comments.length;
      r.terminalAttempts += 1;
      await assert.rejects(
        () => withLifecycleFaultInjection({ checkpoint: "reachability_proven", position: "after" }, () => finalizeIssue(r.leases, r.authority, {
          cwd: r.git.repo,
          issueNumber: ISSUE,
          agent: "pi-next",
          runId: m.owner,
          sessionId: `${m.owner}-session`,
          issueUpdatedAt: "2026-08-22T12:00:00.000Z",
          candidateSha: r.candidateSha!,
          verifiedAuthorityFingerprint: r.verifiedFingerprint!,
        })),
        LifecycleCheckpointFault,
      );
      const integratedMain = await r.git.git(r.git.repo, "rev-parse", "refs/remotes/origin/main");
      const retry = await finalizeIssue(r.leases, r.authority, {
        cwd: r.git.repo,
        issueNumber: ISSUE,
        agent: "pi-next",
        runId: m.owner,
        sessionId: `${m.owner}-session`,
        issueUpdatedAt: "2026-08-22T12:00:00.000Z",
        candidateSha: r.candidateSha!,
        verifiedAuthorityFingerprint: r.verifiedFingerprint!,
        verifiedIntegratedMain: integratedMain,
      });
      r.terminalAttempts += 1;
      m.candidate = "integrated";
      m.integratedReachable = true;
      if (retry.closed) {
        m.closed = true;
        m.closeWasAuthorized = true;
        m.work = "completed";
      }
      m.duplicateTerminalSideEffect = (await r.authority.get(String(ISSUE))).comments.length > commentsBefore + (retry.closed ? 1 : 0);
    } else if (m.closed) {
      const commentsBefore = (await r.authority.get(String(ISSUE))).comments.length;
      const retry = await finalizeIssue(r.leases, r.authority, {
        cwd: r.git.repo,
        issueNumber: ISSUE,
        agent: "pi-next",
        runId: m.owner,
        sessionId: `${m.owner}-session`,
        issueUpdatedAt: "2026-08-22T12:00:00.000Z",
        candidateSha: r.candidateSha!,
        verifiedAuthorityFingerprint: r.verifiedFingerprint ?? "",
        verifiedIntegratedMain: await r.git.git(r.git.repo, "rev-parse", "refs/remotes/origin/main"),
      });
      m.duplicateTerminalSideEffect = retry.closed || (await r.authority.get(String(ISSUE))).comments.length !== commentsBefore;
    }
    await this.done(m, r, this.toString());
  }
  toString() { return "crashResumeRetry()"; }
}

class CleanupCommand extends LifecycleCommand {
  check(m: Readonly<LifecycleModel>) { return m.workspace !== "absent"; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    const unique = m.workspace === "canonical-dirty" || m.candidate === "committed";
    if (m.candidate === "integrated" && m.integratedReachable) {
      await cleanupCompletedIssueWorktree(r.git.repo, r.worktree!, ISSUE);
      m.workspace = "absent";
    } else {
      const beforeStatus = r.worktree
        ? await r.git.git(r.worktree, "status", "--porcelain=v1", "--untracked-files=all").catch(() => "missing")
        : "missing";
      await assert.rejects(() => cleanupCompletedIssueWorktree(r.git.repo, r.worktree!, ISSUE));
      const afterStatus = r.worktree
        ? await r.git.git(r.worktree, "status", "--porcelain=v1", "--untracked-files=all").catch(() => "missing")
        : "missing";
      m.cleanupDeletedUnique = unique && afterStatus === "missing";
      m.cleanupRanBeforeReachability = !m.integratedReachable && afterStatus === "missing";
      await invariant(m, r, beforeStatus === afterStatus, "cleanup guard changed unintegrated workspace state");
    }
    await this.done(m, r, this.toString());
  }
  toString() { return "releaseCleanup()"; }
}

class UnrelatedClaimAfterRaceCommand extends LifecycleCommand {
  check(_m: Readonly<LifecycleModel>) { return true; }
  async run(m: LifecycleModel, r: RealLifecycle) {
    try {
      await claimIssueLease(r.leases, leaseInput(OTHER_ISSUE, "other-owner", r.clock), r.clock.now());
    } catch {
      m.unrelatedClaimBlocked = true;
    }
    await this.done(m, r, this.toString());
  }
  toString() { return "claimUnrelatedAfterCandidateRace()"; }
}

function commandsArbitrary() {
  return fc.commands<LifecycleModel, RealLifecycle, false>([
    fc.constant(new DiscoverSelectCommand()),
    fc.constant(new ClaimCommand(OWNER_A)),
    fc.constant(new ClaimCommand(OWNER_B)),
    fc.constant(new LoseRaceCommand()),
    fc.constant(new ExpireCommand()),
    fc.constant(new PrepareWorkspaceCommand()),
    fc.constant(new MakeDirtyCommand()),
    fc.constant(new StaticPreflightFailCommand()),
    fc.constant(new StartWorkerCommand()),
    fc.constant(new FinishWorkerCommand()),
    fc.constant(new FailOrCancelWorkerCommand()),
    fc.constant(new StaleWorkerMutationAttemptCommand()),
    fc.constant(new AuthorityChangeCommand()),
    fc.constant(new CommitCandidateCommand()),
    fc.constant(new VerifyPassCommand()),
    fc.constant(new VerifyFailCommand()),
    fc.constant(new PromoteCloseCommand()),
    fc.constant(new PendingVerificationCommand()),
    fc.constant(new ReleaseCommand()),
    fc.constant(new CrashResumeCommand()),
    fc.constant(new CleanupCommand()),
    fc.constant(new UnrelatedClaimAfterRaceCommand()),
  ], { maxCommands: Number(process.env.PI_NEXT_LIFECYCLE_MODEL_MAX_COMMANDS ?? 20) });
}

test("property: generated lifecycle sequences preserve authority, verification, cleanup, and restart invariants", async () => {
  const runs = Number(process.env.PI_NEXT_LIFECYCLE_MODEL_RUNS ?? 25);
  const seed = Number(process.env.PI_NEXT_LIFECYCLE_MODEL_SEED ?? 790079);
  await fc.assert(
    fc.asyncProperty(commandsArbitrary(), async (cmds) => {
      const real = await createReal();
      try {
        await fc.asyncModelRun(() => ({ model: initialModel(), real }), cmds);
      } finally {
        real.activeWorker?.controller.abort();
        await real.activeWorker?.result.catch(() => undefined);
        await real.git.cleanup();
      }
    }),
    {
      seed,
      numRuns: runs,
      endOnFailure: true,
      verbose: true,
    },
  );
});

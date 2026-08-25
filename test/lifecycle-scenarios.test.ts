import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  authorityFingerprint,
  claimIssueLease,
  createIssueLease,
  ensureIssueWorktree,
  finalizeIssue,
  InMemoryWorkAuthority,
  isAwaitingExternalVerification,
  LeaseConflictError,
  type AuthorityWorkItem,
  type IssueLease,
} from "../src/coordination/index.ts";
import type { WorkerTask } from "../src/coordination/worker-adapter.ts";
import { classifyFailure } from "../extensions/pi-next/failure-scope.ts";
import { containIssueLocalFailure } from "../extensions/pi-next/loop.ts";
import {
  emptyLoopMetrics,
  type LoopState,
} from "../extensions/pi-next/loop-state.ts";
import { PlanAuthorityError } from "../extensions/pi-next/util-core.ts";
import type {
  IssueWorkerOptions,
  IssueWorkerResult,
  IssueWorkerRunner,
} from "../extensions/pi-next/util-core.ts";
import {
  runLifecycleScenario,
  type LifecycleScenarioContext,
} from "./helpers/lifecycle-scenario.ts";

function leaseInput(
  issueNumber: number,
  runId: string,
  acquiredAt: string,
  expiresAt: string,
) {
  return {
    issueNumber,
    agent: "pi-next",
    runId,
    sessionId: `${runId}-session`,
    acquiredAt,
    expiresAt,
  } as const;
}

function farFutureLease(issueNumber: number, runId: string): IssueLease {
  return createIssueLease(
    leaseInput(issueNumber, runId, "2026-08-22T00:00:00.000Z", "2099-01-01T00:00:00.000Z"),
  );
}

function loopState(
  root: string,
  workspace: string,
  lease: IssueLease,
  overrides: Partial<LoopState> = {},
): LoopState {
  return {
    version: 1,
    runId: lease.runId,
    requestedIssues: 2,
    remainingIssues: 2,
    step: 1,
    settledStep: 1,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "running",
    stopRequested: false,
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
    metrics: emptyLoopMetrics(),
    coordinationCwd: root,
    activeIssueNumber: lease.issueNumber,
    activeWorkspace: workspace,
    activeLease: lease,
    ...overrides,
  };
}

function workItem(issueNumber: number, body = "original requirement"): AuthorityWorkItem {
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: `Issue ${issueNumber}`,
    body,
    state: "open",
    updatedAt: "2026-08-22T12:00:00.000Z",
    priority: "P1",
    states: ["Todo"],
    comments: [],
  };
}

async function candidateCommit(
  context: LifecycleScenarioContext,
  issueNumber: number,
): Promise<{ path: string; sha: string }> {
  const worktree = await context.git.addIssueWorktree(issueNumber);
  await context.git.write(worktree.path, `candidate-${issueNumber}.txt`, `candidate ${issueNumber}\n`);
  const sha = await context.git.commit(
    worktree.path,
    `feat: candidate for #${issueNumber}`,
  );
  return { path: worktree.path, sha };
}

function scriptedRunner(
  context: LifecycleScenarioContext,
): IssueWorkerRunner {
  return async (cwd: string, prompt: string, options: IssueWorkerOptions = {}) => {
    const controller = options.signal ? undefined : new AbortController();
    const task: WorkerTask = {
      cwd,
      prompt,
      issueNumber: options.issueNumber,
      runId: options.runId,
      phase: options.phase,
      dispatch: options.dispatch,
      coordinationCwd: options.coordinationCwd,
      readOnly: options.readOnly,
    };
    return context.worker.run(
      task,
      options.signal ?? controller!.signal,
    ) as Promise<IssueWorkerResult>;
  };
}

test("scenario 1: two owners race for one issue and exactly one wins", async () => {
  await runLifecycleScenario({
    name: "two owners race for one issue",
    steps: [{
      name: "claim with concurrent CAS",
      async run({ leaseAuthority, clock, invariant }) {
        const acquiredAt = clock.iso();
        const expiresAt = new Date(clock.now().getTime() + 30 * 60_000).toISOString();
        const attempts = await Promise.allSettled([
          claimIssueLease(leaseAuthority, leaseInput(101, "run-a", acquiredAt, expiresAt), clock.now()),
          claimIssueLease(leaseAuthority, leaseInput(101, "run-b", acquiredAt, expiresAt), clock.now()),
        ]);
        const winners = attempts.filter((entry) => entry.status === "fulfilled");
        const losers = attempts.filter((entry) => entry.status === "rejected");
        invariant(winners.length === 1, "exactly one claim must succeed");
        invariant(losers.length === 1, "exactly one claim must lose");
        invariant(
          losers[0].status === "rejected" && losers[0].reason instanceof LeaseConflictError,
          "loser must receive a fresh-owner conflict",
        );
        const live = await leaseAuthority.read(101);
        invariant(
          live?.runId === (winners[0].status === "fulfilled" ? winners[0].value.runId : undefined),
          "authoritative lease must belong to the sole winner",
        );
      },
    }],
  });
});

test("scenario 2: fresh foreign lease prevents worker launch for losing owner", async () => {
  const foreign = createIssueLease(
    leaseInput(102, "foreign-run", "2026-08-22T11:55:00.000Z", "2026-08-22T12:25:00.000Z"),
  );
  await runLifecycleScenario({
    name: "fresh foreign lease skips worker",
    initialLeases: [foreign],
    workerScripts: [{ behavior: "success" }],
    steps: [{
      name: "reject claim before worker",
      async run({ leaseAuthority, clock, worker, invariant }) {
        await assert.rejects(
          claimIssueLease(
            leaseAuthority,
            leaseInput(102, "local-run", clock.iso(), "2026-08-22T12:30:00.000Z"),
            clock.now(),
          ),
          LeaseConflictError,
        );
        invariant(worker.invocations.length === 0, "losing owner must launch zero workers");
        invariant((await leaseAuthority.read(102))?.runId === "foreign-run", "foreign owner must remain untouched");
      },
    }],
  });
});

test("scenario 3: stale takeover preserves canonical dirty work before mutation", async () => {
  const stale = createIssueLease(
    leaseInput(103, "stale-run", "2026-08-22T10:00:00.000Z", "2026-08-22T10:30:00.000Z"),
  );
  await runLifecycleScenario({
    name: "stale takeover preserves canonical work",
    initialLeases: [stale],
    steps: [{
      name: "prepare dirty canonical worktree",
      async run(context) {
        const worktree = await context.git.addIssueWorktree(103);
        await context.git.write(worktree.path, "unique-dirty.txt", "do not delete\n");
      },
    }, {
      name: "take over stale lease and reattach",
      async run({ git, leaseAuthority, clock, invariant }) {
        const claimed = await claimIssueLease(
          leaseAuthority,
          leaseInput(103, "new-run", clock.iso(), "2026-08-22T12:30:00.000Z"),
          clock.now(),
        );
        const path = await ensureIssueWorktree(git.repo, 103, undefined, {
          ownership: { lease: claimed, authority: leaseAuthority },
        });
        invariant((await leaseAuthority.read(103))?.runId === "new-run", "stale lease must be replaced by new owner");
        invariant(await readFile(join(path, "unique-dirty.txt"), "utf8") === "do not delete\n", "unique dirty work must survive takeover");
      },
    }],
  });
});

test("scenario 4: nonzero worker failure is bounded and never becomes completion", async () => {
  await runLifecycleScenario({
    name: "nonzero worker failure evidence",
    workerScripts: [{ behavior: "failure", output: `${"x".repeat(4_000)}\nERROR deterministic failure` }],
    steps: [{
      name: "execute failing scripted worker",
      async run({ git, worker, invariant }) {
        const result = await worker.run(
          { cwd: git.repo, prompt: "fail", issueNumber: 104, runId: "failure-run" },
          new AbortController().signal,
        );
        invariant(result.ok === false, "failed worker cannot report success");
        invariant(result.code === 1, "nonzero failure must retain exit code");
        invariant((result.failure?.diagnosticExcerpt.length ?? 0) <= 1_000, "failure diagnostic must remain bounded");
      },
    }],
  });
});

test("scenario 6: authority changes after verification so integration lands but issue stays open", async () => {
  await runLifecycleScenario({
    name: "authority changes before closure",
    steps: [{
      name: "integrate against changed live authority",
      async run(context) {
        const issue = 106;
        const candidate = await candidateCommit(context, issue);
        const lease = farFutureLease(issue, "authority-change-run");
        context.leaseAuthority.seed(lease);
        const verifiedItem = workItem(issue, "verified requirement");
        const changedItem = { ...verifiedItem, body: "verified requirement plus new authority" };
        const workAuthority = new InMemoryWorkAuthority([verifiedItem]);
        workAuthority.upsert(changedItem);
        const result = await finalizeIssue(context.leaseAuthority, workAuthority, {
          cwd: context.git.repo,
          issueNumber: issue,
          agent: lease.agent,
          runId: lease.runId,
          sessionId: lease.sessionId,
          candidateSha: candidate.sha,
          issueUpdatedAt: verifiedItem.updatedAt || "",
          verifiedAuthorityFingerprint: authorityFingerprint(verifiedItem),
        });
        context.invariant(result.closed === false, "changed authority must prevent closure");
        context.invariant(result.authorityChanged === true, "result must identify authority change");
        context.invariant((await workAuthority.get(String(issue))).state === "open", "authority item must remain open");
        await context.git.git(context.git.repo, "merge-base", "--is-ancestor", candidate.sha, "origin/main");
      },
    }],
  });
});

test("scenario 7: pending external verification keeps integration and open-state semantics distinct", async () => {
  await runLifecycleScenario({
    name: "pending external verification",
    steps: [{
      name: "integrate and mark pending without closing",
      async run(context) {
        const issue = 107;
        const candidate = await candidateCommit(context, issue);
        const lease = farFutureLease(issue, "pending-run");
        context.leaseAuthority.seed(lease);
        const item = workItem(issue);
        const workAuthority = new InMemoryWorkAuthority([item]);
        const result = await finalizeIssue(context.leaseAuthority, workAuthority, {
          cwd: context.git.repo,
          issueNumber: issue,
          agent: lease.agent,
          runId: lease.runId,
          sessionId: lease.sessionId,
          candidateSha: candidate.sha,
          issueUpdatedAt: item.updatedAt || "",
          verifiedAuthorityFingerprint: authorityFingerprint(item),
          pendingVerification: {
            criteria: [{
              id: "preview-smoke",
              description: "Verify the integrated candidate in preview",
              environment: "preview",
            }],
          },
        });
        const live = await workAuthority.get(String(issue));
        context.invariant(result.closed === false, "pending verification must not close authority item");
        context.invariant(result.pendingVerification?.integratedMainSha === result.mergeSha, "pending record must bind exact integrated main");
        context.invariant(live.state === "open", "pending authority item must remain open");
        context.invariant(isAwaitingExternalVerification(live), "authority item must project awaiting external verification");
      },
    }],
  });
});

test("scenario 8: candidate-local containment leaves queue runnable for unrelated work", async () => {
  await runLifecycleScenario({
    name: "candidate-local failure does not stop queue",
    steps: [{
      name: "contain first issue",
      async run(context) {
        const issue = 108;
        const worktree = await context.git.addIssueWorktree(issue);
        await mkdir(join(worktree.path, ".pi-next"), { recursive: true });
        const plan = join(worktree.path, ".pi-next", "PLAN.md");
        await writeFile(plan, "foreign or malformed plan\n");
        const lease = farFutureLease(issue, "contain-run");
        context.leaseAuthority.seed(lease);
        const initial = loopState(context.git.repo, worktree.path, lease);
        const classification = classifyFailure(
          new PlanAuthorityError("unowned", "foreign workflow artifact", [plan]),
          {
            stage: "workspace-validation",
            issueNumber: issue,
            workspace: worktree.path,
            coordinationCwd: context.git.repo,
            ownershipProven: true,
          },
        );
        const contained = await containIssueLocalFailure(
          context.git.repo,
          initial,
          classification,
          { authority: context.leaseAuthority, lease },
        );
        context.invariant(contained.status === "running", "candidate-local containment must leave loop running");
        context.invariant(contained.remainingIssues === 1, "only contained issue consumes one requested slot");
        context.invariant(contained.activeIssueNumber === undefined, "contained issue ownership pointers must clear");
        context.invariant(await readFile(plan, "utf8") === "foreign or malformed plan\n", "contained workspace must be preserved");
      },
    }, {
      name: "claim unrelated issue",
      async run({ leaseAuthority, clock, invariant }) {
        const next = await claimIssueLease(
          leaseAuthority,
          leaseInput(208, "next-run", clock.iso(), "2026-08-22T12:30:00.000Z"),
          clock.now(),
        );
        invariant(next.issueNumber === 208, "unrelated eligible issue must remain claimable after containment");
      },
    }],
  });
});

test("scenario 10: canonical dirty workspace is never deleted merely to recover", async () => {
  await runLifecycleScenario({
    name: "unique dirty canonical work survives recovery",
    steps: [{
      name: "prepare dirty canonical workspace",
      async run(context) {
        const worktree = await context.git.addIssueWorktree(110);
        await context.git.write(worktree.path, "only-copy.txt", "unique uncommitted work\n");
      },
    }, {
      name: "reattach canonical workspace non-destructively",
      async run({ git, invariant }) {
        const expected = join(git.repo, ".worktrees", "issue-110");
        const actual = await ensureIssueWorktree(git.repo, 110);
        invariant(actual === expected, "recovery must retain canonical workspace identity");
        invariant(await readFile(join(actual, "only-copy.txt"), "utf8") === "unique uncommitted work\n", "unique dirty file must never be deleted");
        invariant((await git.git(actual, "status", "--porcelain")).includes("only-copy.txt"), "dirty work must remain visibly dirty after recovery");
      },
    }],
  });
});

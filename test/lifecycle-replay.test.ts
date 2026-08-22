import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  appendLifecycleJournal,
  readLifecycleJournal,
} from "../src/coordination/lifecycle-journal.ts";
import {
  evaluateLifecycleReplaySuite,
  planLifecycleRecovery,
} from "../src/evaluation/lifecycle-replay.ts";
import { ScriptedWorkerAdapter } from "../src/evaluation/scripted-worker-adapter.ts";
import { createDisposableGitFixture } from "./helpers/git-fixture.ts";

const replaySuite = resolve(process.cwd(), "test/fixtures/replay/crash-boundaries.json");

test("initial crash-boundary replay corpus is deterministic and complete", () => {
  const results = evaluateLifecycleReplaySuite(replaySuite);
  assert.equal(results.length, 7);
  assert.deepEqual(results.map((result) => result.ok), Array(7).fill(true));
  assert.deepEqual(results.map((result) => result.plan.nextAction), [
    "start_worker",
    "verify_candidate",
    "promote_candidate",
    "reconcile_reachability",
    "reconcile_authority",
    "cleanup_workspace",
    "contained",
  ]);
});

test("post-push replay uses scripted worker plus disposable real Git and never repeats promotion", async () => {
  const fixture = await createDisposableGitFixture({
    initialFiles: { "README.md": "fixture\n", ".gitignore": ".worktrees/\n.pi/\n" },
  });
  try {
    const runId = "replay-real-git";
    const issueNumber = 708;
    const journal = join(fixture.root, "journal", `${runId}.jsonl`);
    const worktree = await fixture.addIssueWorktree(issueNumber);
    const worker = new ScriptedWorkerAdapter([{
      name: "candidate",
      expect: { cwd: worktree.path, issueNumber, runId },
      writes: [{ path: "candidate.txt", content: "verified candidate\n" }],
      commit: { message: "feat: replay candidate" },
      behavior: "success",
    }]);

    appendLifecycleJournal(journal, { runId, issueNumber, event: "lease_claimed", payload: { agent: "pi-next" } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "workspace_prepared", payload: { branch: worktree.branch, worktree: ".worktrees/issue-708" } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "worker_started", payload: { adapterId: worker.id, adapterVersion: worker.version } });
    const workerResult = await worker.run(
      { cwd: worktree.path, prompt: "deterministic fixture", issueNumber, runId },
      new AbortController().signal,
    );
    assert.equal(workerResult.ok, true);
    appendLifecycleJournal(journal, { runId, issueNumber, event: "worker_finished", payload: { adapterId: worker.id, adapterVersion: worker.version, ok: true, code: 0 } });

    const candidateSha = await fixture.revision(worktree.path);
    appendLifecycleJournal(journal, { runId, issueNumber, event: "verification_finished", payload: { verification: "pass", candidateSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "candidate_committed", payload: { candidateSha } });

    await fixture.git(fixture.repo, "merge", "--no-ff", "--no-edit", worktree.branch);
    const mergeSha = await fixture.revision(fixture.repo);
    await fixture.git(fixture.repo, "push", "origin", "HEAD:main");
    appendLifecycleJournal(journal, { runId, issueNumber, event: "promotion_started", payload: { candidateSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "promotion_succeeded", payload: { candidateSha, mergeSha } });

    await fixture.git(fixture.repo, "fetch", "origin", "main");
    await fixture.git(fixture.repo, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main");
    const plan = planLifecycleRecovery(readLifecycleJournal(journal), {
      leaseOwned: true,
      workspaceExists: true,
      candidateReachable: true,
      authorityOpen: true,
    });

    assert.equal(plan.nextAction, "reconcile_reachability");
    assert.equal(plan.mustNotRepeat.includes("promote_candidate"), true);
    assert.equal(worker.invocations.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("completed durable transitions replay as complete without repeating terminal side effects", async () => {
  const fixture = await createDisposableGitFixture({
    initialFiles: { "README.md": "fixture\n", ".gitignore": ".worktrees/\n" },
  });
  try {
    const journal = join(fixture.root, "journal", "complete.jsonl");
    const runId = "replay-complete";
    const issueNumber = 709;
    const candidateSha = "a".repeat(40);
    const mainSha = "b".repeat(40);
    appendLifecycleJournal(journal, { runId, issueNumber, event: "lease_claimed", payload: { agent: "pi-next" } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "workspace_prepared", payload: { worktree: ".worktrees/issue-709" } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "verification_finished", payload: { verification: "pass", candidateSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "promotion_succeeded", payload: { candidateSha, mergeSha: mainSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "reachability_proven", idempotencyKey: `reachable:${candidateSha}:${mainSha}`, payload: { candidateSha, mainSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "authority_reconciled", payload: { authorityFingerprint: "authority", changed: false } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "issue_closed", idempotencyKey: `closed:${mainSha}`, payload: { mainSha } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "workspace_cleaned", idempotencyKey: "cleanup:709", payload: { worktree: ".worktrees/issue-709" } });
    appendLifecycleJournal(journal, { runId, issueNumber, event: "lease_released", idempotencyKey: "release:709", payload: {} });

    const plan = planLifecycleRecovery(readLifecycleJournal(journal), {
      leaseOwned: false,
      workspaceExists: false,
      candidateReachable: true,
      authorityOpen: false,
    });
    assert.equal(plan.nextAction, "complete");
    for (const unsafe of ["promote_candidate", "prove_reachability", "record_pending_or_close", "cleanup_workspace", "release_lease"]) {
      assert.equal(plan.mustNotRepeat.includes(unsafe), true, unsafe);
    }
  } finally {
    await fixture.cleanup();
  }
});

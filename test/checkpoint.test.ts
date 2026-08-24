import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  checkpointBranchName,
  checkpointCommit,
  finalizeRequestedPromotion,
  requestArchiveFinalization,
  requestPromotion,
} from "../extensions/pi-next/checkpoint.ts";
import { workingFingerprint } from "../extensions/pi-next/change-state.ts";
import { piLifecycleJournalFile } from "../extensions/pi-next/lifecycle-journal.ts";
import { readLifecycleJournal } from "../src/coordination/lifecycle-journal.ts";
import { LifecycleCheckpointFault, withLifecycleFaultInjection } from "../src/coordination/lifecycle-checkpoints.ts";
import { createDisposableGitFixture, type DisposableGitFixture } from "./helpers/git-fixture.ts";
import { createIssueLease } from "../src/coordination/issue-authority.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";
import { MemoryIssueLeaseAuthority } from "./helpers/lifecycle-scenario.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const fixture = await createDisposableGitFixture({
    prefix: "pi-next-checkpoint-",
    initialFiles: {
      "README.md": "fixture\n",
      ".gitignore": ".worktrees/\n.pi/\n",
      "package.json": `${JSON.stringify({ scripts: { typecheck: "true", test: "true" } }, null, 2)}\n`,
    },
  });
  const { path: workspace } = await fixture.addIssueWorktree(638);
  return { fixture, root: fixture.root, repo: fixture.repo, workspace };
}

async function cleanup(fixture: DisposableGitFixture): Promise<void> {
  await fixture.cleanup();
}

test("checkpoint branch identity is the canonical agent/issue-N branch", () => {
  assert.equal(checkpointBranchName(638, "run-1"), "agent/issue-638");
  assert.equal(checkpointBranchName(638, "a different run"), "agent/issue-638");
  assert.throws(() => checkpointBranchName(638, "   "), /branch-safe identifier/);
});

test("checkpoint commits on the canonical branch and pushes that identity", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/checkpoint.txt`, "checkpoint\n");
    const result = await checkpointCommit(
      state.workspace,
      638,
      "run-638",
      ["checkpoint.txt"],
      "chore(agent): checkpoint issue progress",
    );
    assert.equal(result.branch, "agent/issue-638");
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.match(await git(state.repo, "ls-remote", "--heads", "origin", "agent/issue-638"), /agent\/issue-638/);
    assert.equal(await git(state.repo, "ls-remote", "--heads", "origin", "pi-next/issue-638/run-638"), "");
    const journal = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-638"));
    const durableEvents = journal.filter((record) => record.event !== "baseline_imported");
    assert.deepEqual(durableEvents.map((record) => record.event), ["candidate_committed", "candidate_pushed"]);
    assert.equal(durableEvents[0].payload.candidateSha, await git(state.workspace, "rev-parse", "HEAD"));
    assert.equal(durableEvents[1].payload.candidateSha, durableEvents[0].payload.candidateSha);
  } finally {
    await cleanup(state.fixture);
  }
});

test("checkpoint restart stays on the canonical branch and stages only explicit paths", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/first.txt`, "first\n");
    await checkpointCommit(state.workspace, 638, "first-run", ["first.txt"], "checkpoint: first");
    await writeFile(`${state.workspace}/second.txt`, "second\n");
    await writeFile(`${state.workspace}/not-checkpointed.txt`, "preserve\n");
    const result = await checkpointCommit(state.workspace, 638, "resumed-run", ["second.txt"], "checkpoint: resumed");
    assert.equal(result.branch, "agent/issue-638");
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.equal(await readFile(`${state.workspace}/not-checkpointed.txt`, "utf8"), "preserve\n");
    assert.equal(await git(state.workspace, "show", "HEAD:not-checkpointed.txt").catch(() => ""), "");
  } finally {
    await cleanup(state.fixture);
  }
});

test("checkpoint rejects foreign branches without switching them", async () => {
  const state = await fixture();
  try {
    await git(state.workspace, "switch", "-c", "agent/issue-999");
    await writeFile(`${state.workspace}/foreign.txt`, "foreign\n");
    await assert.rejects(
      () => checkpointCommit(state.workspace, 638, "run-638", ["foreign.txt"], "checkpoint: foreign"),
      /Refusing to switch from unrelated branch agent\/issue-999/,
    );
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-999");
    assert.equal(await git(state.workspace, "status", "--porcelain"), "?? foreign.txt");
  } finally {
    await cleanup(state.fixture);
  }
});

test("checkpoint never mutates coordination main", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.repo}/coordination-change.txt`, "must remain on main\n");
    await assert.rejects(
      () => checkpointCommit(state.repo, 638, "run-638", ["coordination-change.txt"], "checkpoint: unsafe root"),
    );
    assert.equal(await git(state.repo, "branch", "--show-current"), "main");
    assert.equal(await git(state.repo, "status", "--porcelain"), "?? coordination-change.txt");
  } finally {
    await cleanup(state.fixture);
  }
});

test("checkpointCommit resumes without duplicate commit after crash after local commit before branch push", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/crash.txt`, "crash boundary\n");
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "candidate_pushed", position: "before" }, () =>
        checkpointCommit(state.workspace, 638, "run-crash", ["crash.txt"], "checkpoint: crash boundary"),
      ),
      (error: unknown) => error instanceof LifecycleCheckpointFault
        && error.checkpoint === "candidate_pushed"
        && error.position === "before",
    );
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    assert.equal(await git(state.repo, "ls-remote", "--heads", "origin", "agent/issue-638"), "");

    await checkpointCommit(state.workspace, 638, "run-crash", ["crash.txt"], "checkpoint: crash boundary");

    assert.match(await git(state.repo, "ls-remote", "--heads", "origin", "agent/issue-638"), new RegExp(candidateSha));
    assert.equal(await git(state.workspace, "rev-list", "--count", "main..agent/issue-638"), "1");
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-crash"))
      .filter((record) => record.event !== "baseline_imported");
    assert.deepEqual(events.map((record) => record.event), ["candidate_committed", "candidate_pushed"]);
    assert.equal(events[0].payload.candidateSha, candidateSha);
  } finally {
    await cleanup(state.fixture);
  }
});

test("checkpointCommit resumes without duplicate commit after crash after branch push before completion", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/pushed.txt`, "pushed boundary\n");
    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "candidate_pushed", position: "after" }, () =>
        checkpointCommit(state.workspace, 638, "run-pushed", ["pushed.txt"], "checkpoint: pushed boundary"),
      ),
      LifecycleCheckpointFault,
    );
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");

    await checkpointCommit(state.workspace, 638, "run-pushed", ["pushed.txt"], "checkpoint: pushed boundary");

    assert.match(await git(state.repo, "ls-remote", "--heads", "origin", "agent/issue-638"), new RegExp(candidateSha));
    assert.equal(await git(state.workspace, "rev-list", "--count", "main..agent/issue-638"), "1");
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-pushed"))
      .filter((record) => record.event !== "baseline_imported");
    assert.deepEqual(events.map((record) => record.event), ["candidate_committed", "candidate_pushed"]);
  } finally {
    await cleanup(state.fixture);
  }
});

async function writePassingVerification(cwd: string, verifiedAuthorityFingerprint: string): Promise<string> {
  const verificationPath = join(cwd, "..", "VERIFY.md");
  const fingerprint = await workingFingerprint(cwd);
  await writeFile(verificationPath, `STATUS: PASS\nFINGERPRINT: ${fingerprint}\nISSUE_FINGERPRINT: ${verifiedAuthorityFingerprint}\nAUTHORITY_STATUS: VERIFIED\n`);
  return verificationPath;
}

const IDENTITY = { agent: "pi-next", runId: "run-638-loop", sessionId: "run-638-loop-session" };

function freshLeaseAuthority(issueNumber: number): MemoryIssueLeaseAuthority {
  const now = new Date();
  const authority = new MemoryIssueLeaseAuthority();
  authority.seed(createIssueLease({
    issueNumber,
    agent: IDENTITY.agent,
    runId: IDENTITY.runId,
    sessionId: IDENTITY.sessionId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  }));
  return authority;
}

function workItem(issueNumber: number, updatedAt: string): AuthorityWorkItem {
  return { id: String(issueNumber), number: issueNumber, title: `issue #${issueNumber}`, body: "", state: "open", updatedAt, states: [], comments: [] };
}

test("requestPromotion records readiness without touching main; finalizeRequestedPromotion performs the merge and closes", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/promote.txt`, "promote boundary\n");
    await checkpointCommit(state.workspace, 638, "run-promote", ["promote.txt"], "checkpoint: promote boundary");
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(state.workspace, "rev-parse", "refs/remotes/origin/main");
    const workAuthority = new InMemoryWorkAuthority([workItem(638, "2026-08-19T00:00:00Z")]);
    const verificationPath = await writePassingVerification(state.workspace, workAuthority.fingerprint(await workAuthority.get("638")));

    await requestPromotion(state.workspace, 638, "run-promote", expectedMainSha, verificationPath);
    // The worker never merges or pushes main itself (#146).
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.equal(await git(state.repo, "branch", "--show-current"), "main");
    assert.equal(
      await git(state.workspace, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "no",
    );

    const leaseAuthority = freshLeaseAuthority(638);
    const result = await finalizeRequestedPromotion(state.repo, 638, leaseAuthority, workAuthority, IDENTITY);

    assert.ok(result);
    assert.equal(result!.closed, true);
    assert.equal(
      await git(state.repo, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
    assert.equal((await workAuthority.get("638")).state, "closed");
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-promote"))
      .filter((record) => record.event !== "baseline_imported");
    assert.ok(events.some((record) => record.event === "promotion_requested"));

    // No request left to resolve on a second call.
    assert.equal(await finalizeRequestedPromotion(state.repo, 638, leaseAuthority, workAuthority, IDENTITY), undefined);
  } finally {
    await cleanup(state.fixture);
  }
});

test("requestArchiveFinalization records the same kind of request as requestPromotion; finalizeRequestedPromotion resolves either", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/archived.txt`, "archive boundary\n");
    await git(state.workspace, "add", "archived.txt");
    await git(state.workspace, "commit", "-m", "chore(agent): archive issue #638 plan");
    const archiveCommitSha = await git(state.workspace, "rev-parse", "HEAD");
    const workAuthority = new InMemoryWorkAuthority([workItem(638, "2026-08-19T00:00:00Z")]);
    const fingerprint = workAuthority.fingerprint(await workAuthority.get("638"));

    // The worker no longer pushes to main directly on the archive path
    // either - it only records the same durable request checkpoint
    // promotion uses (#146 unification).
    await requestArchiveFinalization(state.workspace, 638, "run-archive", archiveCommitSha, fingerprint);
    assert.equal(await git(state.workspace, "branch", "--show-current"), "agent/issue-638");
    assert.equal(await git(state.repo, "branch", "--show-current"), "main");
    assert.equal(
      await git(state.workspace, "merge-base", "--is-ancestor", archiveCommitSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "no",
    );

    const leaseAuthority = freshLeaseAuthority(638);
    const result = await finalizeRequestedPromotion(state.repo, 638, leaseAuthority, workAuthority, IDENTITY);

    assert.ok(result);
    assert.equal(result!.closed, true);
    assert.equal(
      await git(state.repo, "merge-base", "--is-ancestor", archiveCommitSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
    assert.equal((await workAuthority.get("638")).state, "closed");
  } finally {
    await cleanup(state.fixture);
  }
});

test("finalizeRequestedPromotion preserves checkpoint verification authority fingerprint instead of laundering live authority", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/stale-authority.txt`, "stale authority boundary\n");
    await checkpointCommit(state.workspace, 638, "run-stale-authority", ["stale-authority.txt"], "checkpoint: stale authority boundary");
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(state.workspace, "rev-parse", "refs/remotes/origin/main");
    const original = workItem(638, "2026-08-19T00:00:00Z");
    const workAuthority = new InMemoryWorkAuthority([original]);
    const verificationPath = await writePassingVerification(state.workspace, workAuthority.fingerprint(original));
    await requestPromotion(state.workspace, 638, "run-stale-authority", expectedMainSha, verificationPath);

    workAuthority.upsert({ ...original, body: "authority changed after verification", updatedAt: "2026-08-20T00:00:00Z" });
    const result = await finalizeRequestedPromotion(state.repo, 638, freshLeaseAuthority(638), workAuthority, IDENTITY);

    assert.ok(result);
    assert.equal(result!.closed, false);
    assert.equal(result!.authorityChanged, true);
    assert.equal((await workAuthority.get("638")).state, "open");
    assert.equal(
      await git(state.repo, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
  } finally {
    await cleanup(state.fixture);
  }
});

test("finalizeRequestedPromotion preserves archive verification authority fingerprint instead of laundering live authority", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/archive-stale-authority.txt`, "archive stale authority boundary\n");
    await git(state.workspace, "add", "archive-stale-authority.txt");
    await git(state.workspace, "commit", "-m", "chore(agent): archive stale authority issue");
    const archiveCommitSha = await git(state.workspace, "rev-parse", "HEAD");
    const original = workItem(638, "2026-08-19T00:00:00Z");
    const workAuthority = new InMemoryWorkAuthority([original]);
    await requestArchiveFinalization(state.workspace, 638, "run-archive-stale-authority", archiveCommitSha, workAuthority.fingerprint(original));

    workAuthority.upsert({
      ...original,
      comments: [{ id: "authority-comment", author: "user", body: "new requirement", createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z" }],
    });
    const result = await finalizeRequestedPromotion(state.repo, 638, freshLeaseAuthority(638), workAuthority, IDENTITY);

    assert.ok(result);
    assert.equal(result!.closed, false);
    assert.equal(result!.authorityChanged, true);
    assert.equal((await workAuthority.get("638")).state, "open");
    assert.equal(
      await git(state.repo, "merge-base", "--is-ancestor", archiveCommitSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
  } finally {
    await cleanup(state.fixture);
  }
});

test("finalizeRequestedPromotion resumes after a crash between push and close without duplicate merge or close", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/promote-after.txt`, "promote after boundary\n");
    await checkpointCommit(state.workspace, 638, "run-promote-after", ["promote-after.txt"], "checkpoint: promote after boundary");
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(state.workspace, "rev-parse", "refs/remotes/origin/main");
    const workAuthority = new InMemoryWorkAuthority([workItem(638, "2026-08-19T00:00:00Z")]);
    const verificationPath = await writePassingVerification(state.workspace, workAuthority.fingerprint(await workAuthority.get("638")));
    await requestPromotion(state.workspace, 638, "run-promote-after", expectedMainSha, verificationPath);

    const leaseAuthority = freshLeaseAuthority(638);

    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "issue_closed", position: "after" }, () =>
        finalizeRequestedPromotion(state.repo, 638, leaseAuthority, workAuthority, IDENTITY),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal(
      await git(state.repo, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
    assert.equal((await workAuthority.get("638")).state, "closed");
    assert.equal((await workAuthority.get("638")).comments.length, 1);

    const result = await finalizeRequestedPromotion(state.repo, 638, leaseAuthority, workAuthority, IDENTITY);
    assert.ok(result);
    assert.equal(result!.closed, true);
    assert.equal((await workAuthority.get("638")).comments.length, 1);
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-promote-after"))
      .filter((record) => record.event !== "baseline_imported");
    assert.equal(events.filter((record) => record.event === "promotion_requested").length, 1);
  } finally {
    await cleanup(state.fixture);
  }
});

test("production promotion recovery runs required post-integration checks before closing an already integrated candidate", async () => {
  const fixture = await createDisposableGitFixture({
    prefix: "pi-next-checkpoint-reverify-",
    initialFiles: {
      "README.md": "fixture\n",
      ".gitignore": ".worktrees/\n.pi/\n",
      "package.json": `${JSON.stringify({ scripts: { typecheck: "true", test: "node -e \"process.exit(1)\"" } }, null, 2)}\n`,
    },
  });
  try {
    const { path: workspace } = await fixture.addIssueWorktree(639);
    await writeFile(`${workspace}/already-integrated.txt`, "already integrated\n");
    await checkpointCommit(workspace, 639, "run-reverify", ["already-integrated.txt"], "checkpoint: already integrated");
    const candidateSha = await git(workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(workspace, "rev-parse", "refs/remotes/origin/main");
    const leaseAuthority = freshLeaseAuthority(639);
    const workAuthority = new InMemoryWorkAuthority([workItem(639, "2026-08-19T00:00:00Z")]);
    const verificationPath = await writePassingVerification(workspace, workAuthority.fingerprint(await workAuthority.get("639")));
    await requestPromotion(workspace, 639, "run-reverify", expectedMainSha, verificationPath);

    await git(fixture.repo, "merge", "--no-ff", "--no-edit", candidateSha);
    await git(fixture.repo, "push", "-q", "origin", "HEAD:main");
    await assert.rejects(
      finalizeRequestedPromotion(fixture.repo, 639, leaseAuthority, workAuthority, IDENTITY),
      /npm test failed during post-integration reverification/,
    );
    assert.equal((await workAuthority.get("639")).state, "open");
    assert.equal(
      await git(fixture.repo, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
  } finally {
    await fixture.cleanup();
  }
});

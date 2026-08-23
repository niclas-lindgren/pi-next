import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  checkpointBranchName,
  checkpointCommit,
  promoteCheckpoint,
} from "../extensions/pi-next/checkpoint.ts";
import { workingFingerprint } from "../extensions/pi-next/change-state.ts";
import { piLifecycleJournalFile } from "../extensions/pi-next/lifecycle-journal.ts";
import { readLifecycleJournal } from "../src/coordination/lifecycle-journal.ts";
import { LifecycleCheckpointFault, withLifecycleFaultInjection } from "../src/coordination/lifecycle-checkpoints.ts";
import { createDisposableGitFixture, type DisposableGitFixture } from "./helpers/git-fixture.ts";

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

async function writePassingVerification(cwd: string): Promise<string> {
  const verificationPath = join(cwd, "..", "VERIFY.md");
  const fingerprint = await workingFingerprint(cwd);
  await writeFile(verificationPath, `STATUS: PASS\nFINGERPRINT: ${fingerprint}\n`);
  return verificationPath;
}

test("promoteCheckpoint resumes after local merge before remote main push without duplicate merge", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/promote.txt`, "promote boundary\n");
    await checkpointCommit(state.workspace, 638, "run-promote-before", ["promote.txt"], "checkpoint: promote boundary");
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(state.workspace, "rev-parse", "refs/remotes/origin/main");
    const verificationPath = await writePassingVerification(state.workspace);
    await git(state.repo, "switch", "--detach");

    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "promotion_pushed", position: "before" }, () =>
        promoteCheckpoint(state.workspace, 638, "run-promote-before", expectedMainSha, verificationPath),
      ),
      LifecycleCheckpointFault,
    );
    assert.equal(await git(state.workspace, "branch", "--show-current"), "main");
    assert.equal(
      await git(state.workspace, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "no",
    );

    await promoteCheckpoint(state.workspace, 638, "run-promote-before", expectedMainSha, verificationPath);

    assert.equal(
      await git(state.workspace, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
    assert.equal(await git(state.workspace, "rev-list", "--merges", "--count", `${expectedMainSha}..refs/remotes/origin/main`), "1");
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-promote-before"))
      .filter((record) => record.event !== "baseline_imported");
    assert.ok(events.some((record) => record.event === "promotion_pushed"));
    assert.ok(events.some((record) => record.event === "reachability_proven"));
  } finally {
    await cleanup(state.fixture);
  }
});

test("promoteCheckpoint resumes after remote main push without duplicate merge", async () => {
  const state = await fixture();
  try {
    await writeFile(`${state.workspace}/promote-after.txt`, "promote after boundary\n");
    await checkpointCommit(state.workspace, 638, "run-promote-after", ["promote-after.txt"], "checkpoint: promote after boundary");
    const candidateSha = await git(state.workspace, "rev-parse", "HEAD");
    const expectedMainSha = await git(state.workspace, "rev-parse", "refs/remotes/origin/main");
    const verificationPath = await writePassingVerification(state.workspace);
    await git(state.repo, "switch", "--detach");

    await assert.rejects(
      withLifecycleFaultInjection({ checkpoint: "promotion_pushed", position: "after" }, () =>
        promoteCheckpoint(state.workspace, 638, "run-promote-after", expectedMainSha, verificationPath),
      ),
      LifecycleCheckpointFault,
    );

    await promoteCheckpoint(state.workspace, 638, "run-promote-after", expectedMainSha, verificationPath);

    assert.equal(
      await git(state.workspace, "merge-base", "--is-ancestor", candidateSha, "refs/remotes/origin/main").then(() => "yes").catch(() => "no"),
      "yes",
    );
    assert.equal(await git(state.workspace, "rev-list", "--merges", "--count", `${expectedMainSha}..refs/remotes/origin/main`), "1");
    const events = readLifecycleJournal(piLifecycleJournalFile(state.workspace, "run-promote-after"))
      .filter((record) => record.event !== "baseline_imported");
    assert.equal(events.filter((record) => record.event === "promotion_pushed").length, 1);
    assert.equal(events.filter((record) => record.event === "promotion_succeeded").length, 1);
  } finally {
    await cleanup(state.fixture);
  }
});

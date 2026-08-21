import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { createIssueLease, type IssueLease } from "../src/coordination/issue-authority.ts";
import type { IssueLeaseAuthority } from "../src/coordination/issue-leases.ts";
import { finalizeIssue, FinalizeError } from "../src/coordination/finalize.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";

/**
 * `finalizeIssue()` is exercised against a real git repo (a bare `origin`
 * plus a working `root` clone with `main` checked out, matching the
 * coordination-checkout shape) so merge/push/reachability/race behavior
 * runs for real, not against a mocked git. The lease authority is a simple
 * in-memory fake (finalize takes it as a parameter specifically so tests
 * don't need real GitHub CAS machinery), and the work-item authority is the
 * package's own `InMemoryWorkAuthority` -- exercising the exact
 * `WorkAuthorityAdapter` boundary finalize's close/comment step goes
 * through in production (#19), with no network or `gh` dependency (#19).
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function mktemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class MemoryLeaseAuthority implements IssueLeaseAuthority {
  private lease: IssueLease | undefined;

  seed(lease: IssueLease): void {
    this.lease = lease;
  }

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    return this.lease?.issueNumber === issueNumber ? this.lease : undefined;
  }

  async create(): Promise<void> {
    throw new Error("not needed for finalize tests");
  }

  async replace(): Promise<void> {
    throw new Error("not needed for finalize tests");
  }

  async remove(): Promise<void> {
    this.lease = undefined;
  }
}

function freshLease(issueNumber: number, overrides: Partial<IssueLease> = {}): IssueLease {
  const now = new Date();
  const base = createIssueLease({
    issueNumber,
    agent: "claude",
    runId: "run-1",
    sessionId: "session-1",
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  });
  return { ...base, ...overrides };
}

function workItem(issueNumber: number, updatedAt: string): AuthorityWorkItem {
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: `issue #${issueNumber}`,
    body: "",
    state: "open",
    updatedAt,
    states: ["priority: P1"],
    comments: [],
  };
}

/** Sets up a bare `origin` and a `root` clone with `main` checked out and pushed. */
function setupRepo(): { origin: string; root: string } {
  const origin = mktemp("finalize-origin-");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  const root = mktemp("finalize-root-");
  execFileSync("git", ["clone", "-q", origin, root]);
  git(root, ["config", "user.name", "Finalize Test"]);
  git(root, ["config", "user.email", "finalize@example.invalid"]);
  writeFileSync(join(root, "README.md"), "baseline\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "baseline"]);
  git(root, ["branch", "-M", "main"]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  return { origin, root };
}

/** Creates `agent/issue-N` with one commit ahead of main, then returns root to `main`. */
function createCandidateBranch(root: string, issueNumber: number, file: string): string {
  git(root, ["switch", "-c", `agent/issue-${issueNumber}`]);
  writeFileSync(join(root, file), "candidate change\n");
  git(root, ["add", file]);
  git(root, ["commit", "-qm", `feat: issue #${issueNumber} candidate`]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "main"]);
  return sha;
}

async function expectRejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    assert.fail(`expected rejection with code ${code}`);
  } catch (error) {
    assert.ok(error instanceof FinalizeError, `expected a FinalizeError, got ${String(error)}`);
    assert.equal((error as FinalizeError).code, code);
  }
}

describe("finalizeIssue", { concurrency: false }, () => {
  test("integrates the candidate into main and closes the issue when lease and authority are unchanged", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 601, "feature.txt");

    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(601));
    const workAuthority = new InMemoryWorkAuthority([workItem(601, "2026-08-19T00:00:00Z")]);

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 601,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(601, "2026-08-19T00:00:00Z")),
    });

    assert.equal(result.closed, true);
    assert.equal(result.authorityChanged, false);
    assert.equal(result.leaseLostAfterMerge, false);
    // Nothing else landed on main since the candidate branched, so this is
    // a plain fast-forward integration -- no reverification required.
    assert.equal(result.requiresReverification, false);
    assert.match(result.mergeSha, /^[0-9a-f]{40}$/);

    const closedItem = await workAuthority.get("601");
    assert.equal(closedItem.state, "closed");

    // The merge is durably pushed and contains the candidate commit.
    const originMain = git(origin, ["rev-parse", "main"]);
    assert.equal(originMain, result.mergeSha);
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", origin, "merge-base", "--is-ancestor", candidateSha, "main"]),
    );
  });

  test("integrates and records pending post-integration verification while leaving authority open", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 621, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(621));
    const workAuthority = new InMemoryWorkAuthority([workItem(621, "2026-08-19T00:00:00Z")]);
    const criteria = [
      { id: "deploy", description: "Deploy the integrated main revision to staging", environment: "preview" },
      { id: "human-check", description: "Obtain explicit product-owner verification", environment: "human_approval" },
    ] as const;

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 621,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(621, "2026-08-19T00:00:00Z")),
      pendingVerification: { criteria },
    });

    assert.equal(result.closed, false);
    assert.equal(result.authorityChanged, false);
    assert.equal(result.requiresReverification, false);
    assert.deepEqual(result.pendingVerification, {
      version: 1,
      status: "awaiting_external_verification",
      criteria,
      integratedMainSha: result.mergeSha,
    });
    const item = await workAuthority.get("621");
    assert.equal(item.state, "open");
    assert.ok(item.comments.some((comment) => comment.body.includes("pi-next-pending-verification") && comment.body.includes(result.mergeSha)));
    assert.equal(git(origin, ["rev-parse", "main"]), result.mergeSha);
  });

  test("rejects malformed pending verification before any promotion", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 622, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(622));
    const workAuthority = new InMemoryWorkAuthority([workItem(622, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 622,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(622, "2026-08-19T00:00:00Z")),
        pendingVerification: { criteria: [] },
      }),
      "INVALID_PENDING_VERIFICATION",
    );
    assert.equal(git(root, ["log", "-1", "--format=%s", "main"]), "baseline");
  });

  test("refuses to finalize when the lease is not owned by the caller", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 602, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(602, { agent: "pi-next", runId: "other-run" }));
    const workAuthority = new InMemoryWorkAuthority([workItem(602, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 602,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(602, "2026-08-19T00:00:00Z")),
      }),
      "LEASE_LOST",
    );

    // No mutation happened: main is unchanged, still at its original tip.
    assert.notEqual(git(root, ["rev-parse", "main"]), candidateSha);
    assert.equal(git(root, ["log", "-1", "--format=%s", "main"]), "baseline");
  });

  test("refuses to finalize when the expired lease has lapsed", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 603, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    const past = new Date(Date.now() - 60_000).toISOString();
    leaseAuthority.seed(freshLease(603, { acquiredAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: past }));
    const workAuthority = new InMemoryWorkAuthority([workItem(603, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 603,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(603, "2026-08-19T00:00:00Z")),
      }),
      "LEASE_LOST",
    );
  });

  test("refuses to finalize a candidate that no longer matches the branch tip", async () => {
    const { root } = setupRepo();
    createCandidateBranch(root, 604, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(604));
    const workAuthority = new InMemoryWorkAuthority([workItem(604, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 604,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha: "0".repeat(40),
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(604, "2026-08-19T00:00:00Z")),
      }),
      "CANDIDATE_STALE",
    );

    assert.equal(git(root, ["log", "-1", "--format=%s", "main"]), "baseline");
  });

  test("refuses to run from anywhere but the main coordination checkout", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 605, "feature.txt");
    git(root, ["switch", "agent/issue-605"]);
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(605));
    const workAuthority = new InMemoryWorkAuthority([workItem(605, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 605,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(605, "2026-08-19T00:00:00Z")),
      }),
      "UNSAFE_ROOT",
    );
  });

  test("refuses to finalize from a dirty coordination checkout without mutating it", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 606, "feature.txt");
    writeFileSync(join(root, "scratch.txt"), "uncommitted\n");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(606));
    const workAuthority = new InMemoryWorkAuthority([workItem(606, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 606,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(606, "2026-08-19T00:00:00Z")),
      }),
      "ROOT_BUSY",
    );

    assert.match(git(root, ["status", "--porcelain"]), /scratch\.txt/);
  });

  test("integrates the candidate but does not close the issue when authority changed since verification", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 607, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(607));
    // live updatedAt differs from the verification-time snapshot below
    const workAuthority = new InMemoryWorkAuthority([workItem(607, "2026-08-19T05:00:00Z")]);

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 607,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z", // stale verification-time snapshot
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(607, "2026-08-19T00:00:00Z")),
    });

    assert.equal(result.closed, false);
    assert.equal(result.authorityChanged, true);
    const item = await workAuthority.get("607");
    assert.equal(item.state, "open");
    // Integration is durable regardless: main advanced and contains the candidate.
    assert.equal(git(origin, ["rev-parse", "main"]), result.mergeSha);
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", origin, "merge-base", "--is-ancestor", candidateSha, "main"]),
    );
  });

  test("final close fencing compares the verified authority fingerprint, not only updatedAt", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 611, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(611));
    const original = workItem(611, "2026-08-19T00:00:00Z");
    const workAuthority = new InMemoryWorkAuthority([original]);
    const verifiedAuthorityFingerprint = workAuthority.fingerprint(original);

    // An authoritative comment arrives without relying on updatedAt changing.
    workAuthority.upsert({
      ...original,
      comments: [{
        id: "decision-1",
        author: "human",
        body: "Requirement changed after verification",
        createdAt: "2026-08-19T01:00:00Z",
        updatedAt: "2026-08-19T01:00:00Z",
      }],
    });

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 611,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: original.updatedAt!,
      verifiedAuthorityFingerprint,
    });

    assert.equal(result.closed, false);
    assert.equal(result.authorityChanged, true);
    assert.equal((await workAuthority.get("611")).state, "open");
  });

  test("reconciles main advancing between verification and finalize, merging safely but requiring reverification before closure", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 608, "feature.txt");

    // Simulate an unrelated issue landing on main after #608's candidate was
    // verified, via a second independent clone pushing directly to origin:
    // the candidate was verified against tree A, but the merged tree is
    // A+B, and A+B was never actually verified together.
    const otherClone = mktemp("finalize-other-clone-");
    execFileSync("git", ["clone", "-q", origin, otherClone]);
    git(otherClone, ["config", "user.name", "Other Issue"]);
    git(otherClone, ["config", "user.email", "other@example.invalid"]);
    writeFileSync(join(otherClone, "unrelated.txt"), "unrelated change\n");
    git(otherClone, ["add", "unrelated.txt"]);
    git(otherClone, ["commit", "-qm", "feat: unrelated issue lands first"]);
    const unrelatedSha = git(otherClone, ["rev-parse", "HEAD"]);
    git(otherClone, ["push", "-q", "origin", "main"]);

    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(608));
    const workAuthority = new InMemoryWorkAuthority([workItem(608, "2026-08-19T00:00:00Z")]);

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 608,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(608, "2026-08-19T00:00:00Z")),
    });

    // The merge/push still lands durably -- main integration isn't held
    // hostage by the reverification gate.
    assert.equal(result.requiresReverification, true);
    assert.equal(result.closed, false);
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", origin, "merge-base", "--is-ancestor", unrelatedSha, "main"]),
    );
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", origin, "merge-base", "--is-ancestor", candidateSha, "main"]),
    );

    // #20: a same-candidate retry with no proof of which integrated main
    // tree was actually reverified finds nothing new to merge, but must NOT
    // treat that as "nothing to reverify" -- candidate reachability alone
    // is not proof the live tree was reverified.
    const retryWithoutProof = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 608,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(608, "2026-08-19T00:00:00Z")),
    });
    assert.equal(retryWithoutProof.requiresReverification, true);
    assert.equal(retryWithoutProof.closed, false);
    assert.equal(retryWithoutProof.mergeSha, result.mergeSha);

    // A retry that supplies the exact integrated main SHA (`mergeSha`) the
    // caller actually reverified closes normally.
    const retry = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 608,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(608, "2026-08-19T00:00:00Z")),
      verifiedIntegratedMain: result.mergeSha,
    });
    assert.equal(retry.requiresReverification, false);
    assert.equal(retry.closed, true);
  });

  test("#20: refuses to close when another commit lands on main after the caller's verified integrated-main proof", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 620, "feature.txt");

    // B lands on main before the candidate is ever integrated.
    const otherClone = mktemp("finalize-other-clone-");
    execFileSync("git", ["clone", "-q", origin, otherClone]);
    git(otherClone, ["config", "user.name", "Other Issue"]);
    git(otherClone, ["config", "user.email", "other@example.invalid"]);
    writeFileSync(join(otherClone, "unrelated-b.txt"), "b\n");
    git(otherClone, ["add", "unrelated-b.txt"]);
    git(otherClone, ["commit", "-qm", "feat: B lands"]);
    git(otherClone, ["push", "-q", "origin", "main"]);

    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(620));
    const workAuthority = new InMemoryWorkAuthority([workItem(620, "2026-08-19T00:00:00Z")]);

    // First finalize integrates A+B+C and reports the exact tree (M1) that
    // must be reverified.
    const first = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 620,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(620, "2026-08-19T00:00:00Z")),
    });
    assert.equal(first.requiresReverification, true);
    const m1 = first.mergeSha;

    // The caller verifies M1 -- but before it retries, an independent D
    // lands on main, so origin/main advances to M2 != M1.
    git(otherClone, ["fetch", "-q", "origin", "main"]);
    git(otherClone, ["merge", "-q", "--ff-only", "origin/main"]);
    writeFileSync(join(otherClone, "unrelated-d.txt"), "d\n");
    git(otherClone, ["add", "unrelated-d.txt"]);
    git(otherClone, ["commit", "-qm", "feat: D lands after M1 was verified"]);
    git(otherClone, ["push", "-q", "origin", "main"]);

    // Retrying with proof of the now-stale M1 must NOT close: the live
    // integrated main tree (M2) was never reverified.
    const retry = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 620,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(620, "2026-08-19T00:00:00Z")),
      verifiedIntegratedMain: m1,
    });
    assert.equal(retry.closed, false);
    assert.equal(retry.requiresReverification, true);
    assert.notEqual(retry.mergeSha, m1);

    const item = await workAuthority.get("620");
    assert.equal(item.state, "open");

    // Retrying again with proof of the new tree (M2) closes normally.
    const finalRetry = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 620,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(620, "2026-08-19T00:00:00Z")),
      verifiedIntegratedMain: retry.mergeSha,
    });
    assert.equal(finalRetry.requiresReverification, false);
    assert.equal(finalRetry.closed, true);
  });

  test("does not close the issue when the lease was lost after a successful merge", async () => {
    const { origin, root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 609, "feature.txt");

    class DropsLeaseAfterFirstRead extends MemoryLeaseAuthority {
      private reads = 0;
      async read(issueNumber: number) {
        this.reads += 1;
        if (this.reads > 1) return undefined;
        return super.read(issueNumber);
      }
    }
    const leaseAuthority = new DropsLeaseAfterFirstRead();
    leaseAuthority.seed(freshLease(609));
    const workAuthority = new InMemoryWorkAuthority([workItem(609, "2026-08-19T00:00:00Z")]);

    const result = await finalizeIssue(leaseAuthority, workAuthority, {
      cwd: root,
      issueNumber: 609,
      agent: "claude",
      runId: "run-1",
      sessionId: "session-1",
      candidateSha,
      issueUpdatedAt: "2026-08-19T00:00:00Z",
      verifiedAuthorityFingerprint: workAuthority.fingerprint(workItem(609, "2026-08-19T00:00:00Z")),
    });

    assert.equal(result.closed, false);
    assert.equal(result.leaseLostAfterMerge, true);
    // The merge still landed durably -- only closure was withheld.
    assert.equal(git(origin, ["rev-parse", "main"]), result.mergeSha);
  });

  test("refuses authoritative completion when verified fingerprint evidence is missing", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 612, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(612));
    const workAuthority = new InMemoryWorkAuthority([workItem(612, "2026-08-19T00:00:00Z")]);

    await expectRejects(
      finalizeIssue(leaseAuthority, workAuthority, {
        cwd: root,
        issueNumber: 612,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
      } as Parameters<typeof finalizeIssue>[2]),
      "MISSING_AUTHORITY_EVIDENCE",
    );
    assert.equal(git(root, ["log", "-1", "--format=%s", "main"]), "baseline");
  });

  test("fails closed when the work authority does not support completion", async () => {
    const { root } = setupRepo();
    const candidateSha = createCandidateBranch(root, 610, "feature.txt");
    const leaseAuthority = new MemoryLeaseAuthority();
    leaseAuthority.seed(freshLease(610));
    const noCompletionAuthority = new InMemoryWorkAuthority([workItem(610, "2026-08-19T00:00:00Z")]);
    // @ts-expect-error -- deliberately violating the readonly capability flag to simulate an adapter without completion support
    noCompletionAuthority.capabilities = { ...noCompletionAuthority.capabilities, completion: false };

    await assert.rejects(
      finalizeIssue(leaseAuthority, noCompletionAuthority, {
        cwd: root,
        issueNumber: 610,
        agent: "claude",
        runId: "run-1",
        sessionId: "session-1",
        candidateSha,
        issueUpdatedAt: "2026-08-19T00:00:00Z",
        verifiedAuthorityFingerprint: noCompletionAuthority.fingerprint(workItem(610, "2026-08-19T00:00:00Z")),
      }),
      /completion/,
    );
    // Refused before any git mutation happened.
    assert.equal(git(root, ["log", "-1", "--format=%s", "main"]), "baseline");
  });
});

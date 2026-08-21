import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryWorkAuthority,
  createIssueLease,
  validatePiNextConfig,
  type AuthorityWorkItem,
  type IssueLease,
  type IssueLeaseAuthority,
} from "../src/coordination/index.ts";
import { candidateShortlist } from "../extensions/pi-next/issue-candidates.ts";

const config = validatePiNextConfig({
  version: 1,
  authority: {
    adapter: "memory",
    projectStatus: { todo: "queued", inProgress: "working", done: "complete", blocked: "paused" },
  },
  selection: { priorities: ["urgent", "normal"], readyStates: ["ready"], blockedStates: ["paused"] },
  repositoryPolicy: { entrypoints: [] },
  workflow: {
    stateDir: ".workflow",
    planPath: ".workflow/PLAN.md",
    verifyPath: ".workflow/VERIFY.md",
    archiveDir: ".workflow/ARCHIVED",
    deferredDir: ".workflow/deferred",
    skillPath: ".workflow/SKILL.md",
    tuningPath: ".workflow/LOOP_TUNING.md",
    helperDir: ".workflow/scripts",
  },
});

function item(number: number): AuthorityWorkItem {
  return {
    id: String(number),
    number,
    title: `candidate ${number}`,
    body: "",
    state: "open",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    priority: "urgent",
    states: ["priority: urgent", "ready"],
    comments: [],
  };
}

function foreignLease(issueNumber: number): IssueLease {
  return createIssueLease({
    issueNumber,
    agent: "other-agent",
    runId: "other-run",
    sessionId: "other-session",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function leaseAuthority(read: IssueLeaseAuthority["read"]): IssueLeaseAuthority {
  return {
    read,
    create: async () => {},
    replace: async () => {},
    remove: async () => {},
  };
}

test("candidate discovery checks leases progressively with bounded concurrency", async () => {
  const authority = new InMemoryWorkAuthority(Array.from({ length: 50 }, (_, index) => item(index + 1)));
  let active = 0;
  let maximum = 0;
  const reads: number[] = [];
  const statuses: string[] = [];
  const leases = leaseAuthority(async (issueNumber) => {
    reads.push(issueNumber);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return issueNumber >= 41 ? foreignLease(issueNumber) : undefined;
  });

  const result = await candidateShortlist("/tmp", {
    authority,
    config,
    refreshMain: false,
    leaseAuthority: leases,
    leaseReadWindow: 4,
    leaseReadConcurrency: 2,
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(result.outcome, "candidate");
  assert.equal(result.candidateIssueNumber, 40);
  assert.equal(maximum, 2);
  assert.ok(reads.length <= 12, `expected a progressive read window, got ${reads.length}`);
  assert.ok(statuses.some((status) => /Querying memory/.test(status)));
  assert.ok(statuses.some((status) => /Checking leases \d+\/4/.test(status)));
});

test("a hung candidate authority read becomes an explicit unavailable result", async () => {
  const authority = new InMemoryWorkAuthority([item(1)]);
  authority.listCandidates = async () => new Promise<AuthorityWorkItem[]>(() => {});
  const started = Date.now();
  const result = await candidateShortlist("/tmp", {
    authority,
    config,
    refreshMain: false,
    authorityTimeoutMs: 20,
    selectionDeadlineMs: 100,
  });

  assert.equal(result.outcome, "unavailable");
  assert.equal(result.exhausted, false);
  assert.match(result.reason || "", /timed out|deadline exceeded/);
  assert.ok(Date.now() - started < 500, "candidate discovery must not await a hung authority forever");
});

test("a hung lease read is bounded and never treated as an unleased issue", async () => {
  const authority = new InMemoryWorkAuthority([item(1), item(2)]);
  const result = await candidateShortlist("/tmp", {
    authority,
    config,
    refreshMain: false,
    leaseAuthority: leaseAuthority(async () => new Promise<IssueLease | undefined>(() => {})),
    authorityTimeoutMs: 20,
    selectionDeadlineMs: 100,
  });

  assert.equal(result.outcome, "unavailable");
  assert.equal(result.candidateIssueNumber, undefined);
  assert.match(result.reason || "", /timed out|deadline exceeded/);
});

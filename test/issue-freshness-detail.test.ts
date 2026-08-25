import assert from "node:assert/strict";
import { test } from "node:test";

import { getLiveIssueDetail } from "../extensions/pi-next/issue-freshness.ts";
import { InMemoryWorkAuthority, type AuthorityWorkItem } from "../src/coordination/work-authority.ts";

function item(overrides: Partial<AuthorityWorkItem> = {}): AuthorityWorkItem {
  return {
    id: "165",
    number: 165,
    title: "fix(auto): route stop through the shared lifecycle scheduler",
    body: "## Goal\n\nMake stop a first-class control.",
    state: "open",
    states: [],
    comments: [
      { id: "c1", author: "niclas-lindgren", body: "Please also cover resume.", createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z" },
    ],
    ...overrides,
  };
}

test("getLiveIssueDetail returns the live title/body/comments through the configured authority adapter, bypassing the worker shell", async () => {
  const authority = new InMemoryWorkAuthority([item()]);
  const detail = await getLiveIssueDetail(process.cwd(), 165, authority);
  assert.equal(detail.number, 165);
  assert.equal(detail.state, "open");
  assert.match(detail.body, /Make stop a first-class control/);
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comments[0]!.author, "niclas-lindgren");
  assert.match(detail.comments[0]!.body, /cover resume/);
});

test("getLiveIssueDetail surfaces an unknown issue as a rejected promise rather than silently returning empty content", async () => {
  const authority = new InMemoryWorkAuthority([]);
  await assert.rejects(() => getLiveIssueDetail(process.cwd(), 999, authority));
});

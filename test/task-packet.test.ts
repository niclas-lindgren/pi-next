import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkerPrompt } from "../src/bootstrap/task-packet.ts";
import type { Issue } from "../src/bootstrap/types.ts";

const issue: Issue = { number: 82, title: "Context", body: "Do the task", comments: [] };
const agents = `# Repository agent instructions

Keep safety instructions.

## Required issue loop

1. Discover live work.
2. Commit, merge, push in that order.
3. Close through authority.

## Controller and recovery regression testing

Run relevant tests.
`;

test("implementation worker packet omits duplicated kernel lifecycle loop from AGENTS", () => {
  const prompt = buildWorkerPrompt(issue, "/tmp/work", [{ path: "AGENTS.md", content: agents }], "implementation");
  assert.match(prompt, /Keep safety instructions/);
  assert.match(prompt, /kernel-owned and are intentionally omitted/);
  assert.doesNotMatch(prompt, /Commit, merge, push in that order/);
  assert.doesNotMatch(prompt, /Close through authority/);
});

test("review packet preserves exact repository context for candidate-bound review", () => {
  const prompt = buildWorkerPrompt(issue, "/tmp/work", [{ path: "AGENTS.md", content: agents }], "review", undefined, "diff");
  assert.match(prompt, /Commit, merge, push in that order/);
  assert.match(prompt, /BEGIN EXACT CANDIDATE EVIDENCE/);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkerPrompt, loadContextFiles } from "../src/bootstrap/task-packet.ts";
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

test("loadContextFiles does not require pi-next-only reliability docs in other repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-context-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# External project\nNo pi-next reliability docs here.\n");

    const files = await loadContextFiles(root, issue);

    assert.deepEqual(files.map((file) => file.path), ["AGENTS.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadContextFiles still fails for explicitly referenced missing repository docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-context-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# External project\nRead docs/MISSING_GUIDE.md before coding.\n");
    await mkdir(join(root, "docs"));

    await assert.rejects(
      () => loadContextFiles(root, issue),
      /referenced repository document is missing: docs\/MISSING_GUIDE\.md/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

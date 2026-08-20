import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { archivePlanFiles } from "../extensions/pi-next/commit-safety.ts";

test("package-owned archive honors consumer workflow paths without a helper script", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-archive-"));
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    const plan = join(cwd, ".pi-next", "PLAN.md");
    const planText = "# Plan: fixture\n\n**Goal:** archive\n\n**GitHub-Issue:** #41\n\n## Tasks\n- [x] done\n\n## Acceptance Criteria\n- [x] complete\n\n## Log\n";
    await writeFile(plan, planText);
    const result = archivePlanFiles(cwd, plan, 41);
    assert.equal(result.archive, join(cwd, ".pi-next", "ARCHIVED", "PLAN-41.md"));
    assert.equal(await readFile(result.archive, "utf8"), planText);
    await assert.rejects(() => readFile(plan, "utf8"));
    assert.match(await readFile(result.history, "utf8"), /Issue #41/);
    await writeFile(plan, planText);
    const second = archivePlanFiles(cwd, plan, 41);
    assert.deepEqual(second, result);
    await assert.rejects(() => readFile(plan, "utf8"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

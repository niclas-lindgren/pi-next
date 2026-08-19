import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { archivePlanArtifacts } from "../extensions/pi-next/archive.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

test("archive is package-owned and respects configured archive paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-archive-"));
  try {
    await exec("git", ["init", "--initial-branch=main", cwd]);
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "pi-next archive test");
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    await writeFile(
      join(cwd, ".pi-next", "config.json"),
      JSON.stringify({
        version: 1,
        authority: { adapter: "memory" },
        selection: { priorities: ["P1"], readyStates: ["open"], blockedStates: ["blocked"] },
        repositoryPolicy: { entrypoints: [] },
        workflow: {
          stateDir: ".state",
          planPath: ".state/PLAN.md",
          verifyPath: ".state/VERIFY.md",
          archiveDir: ".history/plans",
          deferredDir: ".state/deferred",
          skillPath: ".state/SKILL.md",
          tuningPath: ".state/LOOP_TUNING.md",
          helperDir: ".missing-consumer-helpers"
        }
      }, null, 2) + "\n",
    );
    await mkdir(join(cwd, ".state"), { recursive: true });
    const plan = "# Package archive smoke\n\n**GitHub-Issue:** #21\n";
    await writeFile(join(cwd, ".state", "PLAN.md"), plan);

    const result = archivePlanArtifacts(cwd, {
      issue: 21,
      plan,
      now: new Date("2026-08-19T12:00:00Z"),
    });

    assert.equal(result.archive, join(cwd, ".history", "plans", "PLAN-2026-08-19-21-package-archive-smoke.md"));
    assert.equal(await readFile(result.archive, "utf8"), plan);
    assert.match(
      await readFile(result.history, "utf8"),
      /archived verified plan for issue #21 \(Package archive smoke\)/,
    );
    await assert.rejects(readFile(join(cwd, ".state", "PLAN.md"), "utf8"), /ENOENT/);
    await assert.rejects(
      readFile(join(cwd, ".missing-consumer-helpers", "pi-next-archive.sh"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

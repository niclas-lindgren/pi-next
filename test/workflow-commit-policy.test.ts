import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitTelemetryFile, readCommitTelemetry, recordCommit, assertWorkflowCommitAllowed } from "../extensions/pi-next/workflow-commit-policy.ts";
import { commitExplicitPaths } from "../extensions/pi-next/commit-safety.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-workflow-budget-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "pi-next test");
  await writeFile(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-qm", "baseline");
  git(cwd, "switch", "-c", "agent/issue-7");
  return cwd;
}

test("ordinary workflow churn remains bounded while a new required authority version gets one escape", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-workflow-policy-"));
  try {
    recordCommit(cwd, 7, "workflow-only");
    recordCommit(cwd, 7, "lifecycle");
    assert.throws(
      () => assertWorkflowCommitAllowed(cwd, 7),
      /Workflow-only\/lifecycle commit bound reached/,
    );
    assert.doesNotThrow(() => assertWorkflowCommitAllowed(cwd, 7, {
      reason: "authority_reconciliation",
      fingerprint: "authority-v2",
    }));
    recordCommit(cwd, 7, "workflow-only", {
      reason: "authority_reconciliation",
      fingerprint: "authority-v2",
    });
    assert.throws(
      () => assertWorkflowCommitAllowed(cwd, 7, {
        reason: "authority_reconciliation",
        fingerprint: "authority-v2",
      }),
      /refusing duplicate terminal escape/,
    );
    assert.doesNotThrow(() => assertWorkflowCommitAllowed(cwd, 7, {
      reason: "authority_reconciliation",
      fingerprint: "authority-v3",
    }));
    const telemetry = readCommitTelemetry(cwd).issues["7"];
    assert.equal(telemetry.correctnessTransitions, 1);
    assert.equal(telemetry.correctnessByFingerprint["authority_reconciliation:authority-v2"], 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("exhausted budget admits only an evidence-backed PLAN authority reconciliation", async () => {
  const cwd = await repository();
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    await writeFile(join(cwd, ".pi-next", "PLAN.md"), "# Plan: Issue #7\n\n**GitHub-Issue:** #7\n");
    await writeFile(
      join(cwd, ".pi-next", "VERIFY.md"),
      "STATUS: FAIL\nFAIL_DISPOSITION: RECONCILE\nISSUE_FINGERPRINT: authority-v1\nAUTHORITY_ACCEPTANCE_STATUS: MISMATCH\n",
    );
    recordCommit(cwd, 7, "workflow-only");
    recordCommit(cwd, 7, "workflow-only");

    const hash = await commitExplicitPaths(cwd, [".pi-next/PLAN.md"], "chore(agent): reconcile authority", { issueNumber: 7 });
    assert.match(hash, /^[0-9a-f]+$/);
    assert.equal(readCommitTelemetry(cwd).issues["7"].correctnessTransitions, 1);
    assert.match(await readFile(commitTelemetryFile(cwd), "utf8"), /authority_reconciliation:authority-v1/);

    await writeFile(join(cwd, ".pi-next", "HISTORY.md"), "ordinary bookkeeping\n");
    await assert.rejects(
      () => commitExplicitPaths(cwd, [".pi-next/HISTORY.md"], "chore(agent): churn", { issueNumber: 7 }),
      /Workflow-only\/lifecycle commit bound reached/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a pending PLAN task-metadata repair blocks product-source commits until it revalidates", async () => {
  const cwd = await repository();
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    await mkdir(join(cwd, "src"), { recursive: true });
    const invalidPlan = `# Plan: Issue #7\n\n**Goal:** repair task metadata\n\n**GitHub-Issue:** #7\n\n## Tasks\n\n- [ ] Fix the bug\n  - Existing completed work remains intact.\n\n## Acceptance Criteria\n\n- [ ] The bug is fixed.\n\n## Log\n`;
    await writeFile(join(cwd, ".pi-next", "PLAN.md"), invalidPlan);
    await writeFile(join(cwd, "src", "example.ts"), "export const value = 1;\n");

    await assert.rejects(
      () => commitExplicitPaths(cwd, ["src/example.ts"], "fix: implement the bug fix", { issueNumber: 7 }),
      /PLAN task metadata is unresolved/,
    );

    // Repairing only the PLAN metadata is still allowed while it is pending.
    const repairedPlan = invalidPlan.replace(
      "  - Existing completed work remains intact.",
      "  - Files: src/example.ts\n  - Approach: patch the smallest relevant surface.",
    );
    await writeFile(join(cwd, ".pi-next", "PLAN.md"), repairedPlan);
    const planHash = await commitExplicitPaths(cwd, [".pi-next/PLAN.md"], "chore(agent): repair PLAN metadata", { issueNumber: 7 });
    assert.match(planHash, /^[0-9a-f]+$/);

    // Once the PLAN validates, the product-source commit is allowed again.
    const hash = await commitExplicitPaths(cwd, ["src/example.ts"], "fix: implement the bug fix", { issueNumber: 7 });
    assert.match(hash, /^[0-9a-f]+$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("caller-supplied correctness labels cannot bypass mechanical path/evidence checks", async () => {
  const cwd = await repository();
  try {
    await mkdir(join(cwd, ".pi-next"), { recursive: true });
    await writeFile(join(cwd, ".pi-next", "HISTORY.md"), "unsafe bypass\n");
    recordCommit(cwd, 7, "workflow-only");
    recordCommit(cwd, 7, "workflow-only");
    await assert.rejects(
      () => commitExplicitPaths(cwd, [".pi-next/HISTORY.md"], "chore(agent): fake escape", {
        issueNumber: 7,
        correctness: { reason: "authority_reconciliation", fingerprint: "made-up" },
      }),
      /Authority reconciliation requires an unambiguous/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { runCoordinationCli } from "../src/coordination/cli.ts";

const exec = promisify(execFile);

/**
 * Proves the stable, structured JSON-in/JSON-out contract every command
 * emits: exactly one JSON object on success or failure, and a stable `code`
 * on failure that callers branch on instead of message text (#19).
 */

test("workspace derives canonical branch/worktree identity without touching any authority", async () => {
  const result = await runCoordinationCli(["workspace", "--issue", "42"]);
  assert.deepEqual(result, {
    ok: true,
    command: "workspace",
    workspace: { issueNumber: 42, branch: "agent/issue-42", worktree: ".worktrees/issue-42" },
  });
});

test("an unknown command fails closed with INVALID_ARGS", async () => {
  const result = await runCoordinationCli(["bogus"]);
  assert.deepEqual(result, {
    ok: false,
    command: "unknown",
    code: "INVALID_ARGS",
    message: "Unknown command: bogus. Expected one of: status, claim, renew, release, workspace, prepare, finalize",
  });
});

test("an unknown flag fails closed with INVALID_ARGS", async () => {
  const result = await runCoordinationCli(["workspace", "--issue", "1", "--nope"]);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "INVALID_ARGS");
});

test("--issue is required for issue-scoped commands", async () => {
  const result = await runCoordinationCli(["workspace"]);
  assert.deepEqual(result, {
    ok: false,
    command: "workspace",
    code: "INVALID_ARGS",
    message: "--issue <number> is required",
  });
});

test("--agent/--run/--session are required for owner-scoped commands", async () => {
  const result = await runCoordinationCli(["claim", "--issue", "1"]);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "INVALID_ARGS");
  assert.match((result as { message: string }).message, /--agent/);
});

test("finalize requires candidate, authority fingerprint, and verification timestamp", async () => {
  const missingCandidate = await runCoordinationCli([
    "finalize",
    "--issue",
    "1",
    "--agent",
    "claude",
    "--run",
    "run-1",
    "--session",
    "session-1",
    "--issue-updated-at",
    "2026-08-19T00:00:00Z",
  ]);
  assert.equal(missingCandidate.ok, false);
  assert.equal((missingCandidate as { code: string }).code, "INVALID_ARGS");
  assert.match((missingCandidate as { message: string }).message, /--candidate/);

  const missingUpdatedAt = await runCoordinationCli([
    "finalize",
    "--issue",
    "1",
    "--agent",
    "claude",
    "--run",
    "run-1",
    "--session",
    "session-1",
    "--candidate",
    "a".repeat(40),
  ]);
  assert.equal(missingUpdatedAt.ok, false);
  assert.equal((missingUpdatedAt as { code: string }).code, "INVALID_ARGS");
  assert.match((missingUpdatedAt as { message: string }).message, /--issue-updated-at/);

  const missingFingerprint = await runCoordinationCli([
    "finalize",
    "--issue",
    "1",
    "--agent",
    "claude",
    "--run",
    "run-1",
    "--session",
    "session-1",
    "--candidate",
    "a".repeat(40),
    "--issue-updated-at",
    "2026-08-19T00:00:00Z",
  ]);
  assert.equal(missingFingerprint.ok, false);
  assert.equal((missingFingerprint as { code: string }).code, "INVALID_ARGS");
  assert.match((missingFingerprint as { message: string }).message, /--authority-fingerprint/);
});

test("refuses to operate on one issue's identity from inside a different issue's worktree", async () => {
  const cwd = join(tmpdir(), ".worktrees", "issue-99");
  const result = await runCoordinationCli(["claim", "--issue", "5", "--agent", "claude", "--run", "r", "--session", "s", "--cwd", cwd]);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "UNSAFE_ROOT");
});

test("status never throws for a fixture with no resolvable GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-cli-noauth-"));
  try {
    await exec("git", ["init", "-q", root]);
    // No GitHub remote/repo is configured for this fixture, so the ref
    // lookup behind `status` cannot resolve one; the CLI must still return
    // exactly one structured JSON result (an absent lease), never throw.
    const result = await runCoordinationCli(["status", "--issue", "7", "--cwd", root]);
    if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result)}`);
    assert.equal(result.command, "status");
    assert.equal(result.lease, null);
    assert.equal(result.fresh, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the executable bin wrapper prints exactly one JSON line and exits zero on success", async () => {
  const { stdout } = await exec("npx", ["tsx", join(process.cwd(), "src/coordination/bin.ts"), "workspace", "--issue", "3"]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "workspace");
});

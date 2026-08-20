import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { CandidateReviewRequiredError, runCandidateReviewGate } from "../extensions/pi-next/candidate-review.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-review-gate-"));
  await exec("git", ["init", "--initial-branch=main", cwd]);
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "review test");
  await writeFile(join(cwd, "candidate.txt"), "base\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "base");
  await writeFile(join(cwd, "candidate.txt"), "candidate\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "candidate");
  return cwd;
}

test("high-risk verification invokes separate read-only reviewers against the exact candidate", async () => {
  const cwd = await fixture();
  const seen: Array<{ axis?: string; readOnly?: boolean; prompt: string }> = [];
  try {
    await runCandidateReviewGate({
      ctx: { cwd } as never,
      issueNumber: 41,
      authorityFingerprint: "authority-1",
      risk: "high",
      policy: { enabled: true, requiredRisk: "high", maxRounds: 2, axes: ["spec", "standards"] },
      worker: async (_cwd, prompt, options) => {
        seen.push({ axis: options?.phase, readOnly: options?.readOnly, prompt });
        return { ok: true, output: JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: JSON.stringify({ verdict: "pass", findings: [] }) }] } }), code: 0, signal: null, telemetry: { status: "unavailable" } } as never;
      },
    });
    assert.deepEqual(seen.map((item) => item.axis), ["review-spec", "review-standards"]);
    assert.ok(seen.every((item) => item.readOnly === true));
    assert.ok(seen.every((item) => item.prompt.includes("candidate.txt") && item.prompt.includes("authority-1")));
    const record = JSON.parse(await readFile(join(cwd, ".pi", "runtime", "pi-next-review.json"), "utf8")) as { status: string; candidateSha: string; blockingFindings: number };
    assert.equal(record.status, "passed");
    assert.equal(record.blockingFindings, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("blocking findings stop semantic verification until the owner creates a new candidate", async () => {
  const cwd = await fixture();
  try {
    await assert.rejects(
      () => runCandidateReviewGate({
        ctx: { cwd } as never,
        issueNumber: 41,
        authorityFingerprint: "authority-1",
        risk: "critical",
        policy: { enabled: true, requiredRisk: "critical", maxRounds: 1, axes: ["risk"] },
        worker: async () => ({ ok: true, output: JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: JSON.stringify({ verdict: "findings", findings: [{ summary: "unsafe check", evidence: "candidate.txt:1", severity: "blocking", concrete: true }] }) }] } }), code: 0, signal: null, telemetry: { status: "unavailable" } } as never),
      }),
      (error: unknown) => error instanceof CandidateReviewRequiredError && error.candidateSha.length === 40,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

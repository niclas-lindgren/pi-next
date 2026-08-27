import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { WORKER_ADAPTER_VERSION, type WorkerEvent } from "../src/coordination/worker-adapter.ts";
import { buildCodexCliInvocation, CodexCliWorkerAdapter, parseCodexCliJsonl } from "../src/evaluation/codex-cli-worker-adapter.ts";
import { gradeWorkerCanaryFixture, workerCanaryFixtures } from "../src/evaluation/worker-canaries.ts";

test("Codex CLI invocation is unattended, cwd-bound, sandboxed, and credential-scrubbed", () => {
  const invocation = buildCodexCliInvocation(
    { cwd: "/tmp/issue-84", prompt: "fix fixture", readOnly: true },
    {
      command: "codex",
      model: "gpt-codex-test",
      harnessVersion: "codex-cli-test",
      env: {
        PATH: "/bin",
        GITHUB_TOKEN: "secret",
        GH_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        OPENAI_API_KEY: "model-credential",
      },
    },
  );
  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args, [
    "exec",
    "--model", "gpt-codex-test",
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "--cd", "/tmp/issue-84",
    "--json",
    "fix fixture",
  ]);
  assert.equal(invocation.env.GITHUB_TOKEN, undefined);
  assert.equal(invocation.env.GH_TOKEN, undefined);
  assert.equal(invocation.env.SSH_AUTH_SOCK, undefined);
  assert.equal(invocation.env.OPENAI_API_KEY, "model-credential");
  assert.equal(invocation.env.GIT_TERMINAL_PROMPT, "0");
});

test("Codex CLI adapter refuses authority-expanding options", () => {
  assert.throws(() => new CodexCliWorkerAdapter({ sandbox: "danger-full-access" as any }), /danger-full-access/);
  assert.throws(() => new CodexCliWorkerAdapter({ approvalPolicy: "on-request" as any }), /approvalPolicy=never/);
  assert.throws(() => new CodexCliWorkerAdapter({ extraArgs: ["--cd", "/tmp/other"] }), /cannot override --cd/);
});

test("Codex CLI JSONL usage and activity are normalized without raw transcript dependence", () => {
  const parsed = parseCodexCliJsonl([
    JSON.stringify({ type: "turn.completed", model: "codex/test" }),
    JSON.stringify({ type: "exec_command", command: "npm test" }),
    JSON.stringify({ type: "exec_command.end", exit_code: 0 }),
    JSON.stringify({ type: "response.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2, total_tokens: 17, cost_usd: 0.003 } }),
  ].join("\n"));
  assert.equal(parsed.model, "codex/test");
  assert.equal(parsed.modelRounds, 1);
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.toolResults, 1);
  assert.deepEqual(parsed.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: 0.003 });
});

test("Codex CLI adapter implements WorkerAdapter on the independently graded canary seam", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-next-fake-codex-"));
  const fakeCodex = join(tmp, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cd') + 1];
if (!args.includes('exec')) throw new Error('missing exec mode');
if (!args.includes('--json')) throw new Error('missing json mode');
if (args[args.indexOf('--ask-for-approval') + 1] !== 'never') throw new Error('approval must be never');
writeFileSync(join(cwd, 'src/math.ts'), 'export function add(a: number, b: number): number {\\n  return a + b;\\n}\\n');
console.log(JSON.stringify({ type: 'turn.completed', model: 'codex/fake' }));
console.log(JSON.stringify({ type: 'exec_command', command: 'edit' }));
console.log(JSON.stringify({ type: 'response.completed', usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12, cost_usd: 0.001 } }));
`, "utf8");
  await chmod(fakeCodex, 0o755);
  try {
    const events: WorkerEvent[] = [];
    const fixture = workerCanaryFixtures[0];
    const cwd = join(tmp, "fixture");
    for (const file of fixture.files) {
      const path = join(cwd, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, "utf8");
    }
    const adapter = new CodexCliWorkerAdapter({ command: process.execPath, baseArgs: [fakeCodex, "exec"], model: "codex/fake", harnessVersion: "fake-codex-1.0" });
    const worker = await adapter.run({ cwd, prompt: fixture.task, phase: "implementation" }, new AbortController().signal, (event) => events.push(event));
    const graderFailures = await gradeWorkerCanaryFixture(cwd, fixture);
    assert.equal(adapter.id, "codex-cli");
    assert.equal(adapter.version, `${WORKER_ADAPTER_VERSION}+fake-codex-1.0`);
    assert.equal(worker.ok, true);
    assert.deepEqual(graderFailures, []);
    assert.equal(worker.telemetry.model, "codex/fake");
    assert.equal(worker.telemetry.usage?.totalTokens, 12);
    assert.ok(events.some((event) => event.type === "runtime" && event.alive === true));
    assert.ok(events.some((event) => event.type === "activity" && event.kind === "turn.completed"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

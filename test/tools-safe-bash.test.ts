import assert from "node:assert/strict";
import { test } from "node:test";

import { forbiddenWorkerCommand } from "../src/coordination/forbidden-worker-command.ts";
import { registerSafeBashTool } from "../extensions/pi-next/tools-safe-bash.ts";

type SafeBashExecute = (
  id: string,
  params: { command: string },
  signal: AbortSignal | undefined,
  update: () => void,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ type: "text"; text: string }>; details: { refused?: boolean; exitCode?: number | null } }>;

function captureSafeBashTool(): SafeBashExecute | undefined {
  let execute: SafeBashExecute | undefined;
  registerSafeBashTool({
    registerTool(tool: { name: string; execute: SafeBashExecute }) {
      if (tool.name === "safe_bash") execute = tool.execute;
    },
  } as never);
  return execute;
}

test("forbiddenWorkerCommand refuses production worker merge/close/push/gh-issue commands", () => {
  for (const command of [
    "git push origin main",
    "git merge feature",
    "git checkout main",
    "git branch -D feature",
    "gh issue close 162",
    "gh pr merge 162",
    "sudo git push origin main",
    "echo hi; git push origin main",
    "rm -rf .git",
  ]) {
    assert.equal(forbiddenWorkerCommand(command), true, command);
  }
  for (const command of ["npm test", "git status", "git diff", "echo hello"]) {
    assert.equal(forbiddenWorkerCommand(command), false, command);
  }
});

test("production safe_bash tool is registered only for isolated issue workers and refuses authority-bypass commands", async () => {
  const priorWorkerFlag = process.env.PI_NEXT_ISSUE_WORKER;
  try {
    delete process.env.PI_NEXT_ISSUE_WORKER;
    assert.equal(captureSafeBashTool(), undefined);

    process.env.PI_NEXT_ISSUE_WORKER = "1";
    const execute = captureSafeBashTool();
    assert.ok(execute);

    const refused = await execute("call-1", { command: "git push origin main" }, new AbortController().signal, () => {}, { cwd: process.cwd() });
    assert.equal(refused.details.refused, true);
    assert.match(refused.content[0].text, /Refused/);

    const allowed = await execute("call-2", { command: "echo issue-162" }, new AbortController().signal, () => {}, { cwd: process.cwd() });
    assert.equal(allowed.details.exitCode, 0);
    assert.match(allowed.content[0].text, /issue-162/);
  } finally {
    if (priorWorkerFlag === undefined) delete process.env.PI_NEXT_ISSUE_WORKER;
    else process.env.PI_NEXT_ISSUE_WORKER = priorWorkerFlag;
  }
});

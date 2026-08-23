import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function makeDryRun(target: string): Promise<string> {
  const result = await exec("make", ["-n", target], { cwd: packageRoot, encoding: "utf8" });
  return result.stdout;
}

test("make help lists the bootstrap commands", async () => {
  const result = await exec("make", ["help"], { cwd: packageRoot, encoding: "utf8" });
  assert.match(result.stdout, /make bootstrap\s+Run the next self-host issue/);
  assert.match(result.stdout, /make bootstrap-N\s+Run self-host for issue N/);
  assert.match(result.stdout, /make bootstrap-next\s+Show\/select the next self-host issue only/);
});

test("make bootstrap wraps the default self-host command", async () => {
  const stdout = await makeDryRun("bootstrap");
  assert.match(stdout, /npm run bootstrap:self-host\s*$/m);
  assert.doesNotMatch(stdout, /--issue|--next-only/);
});

test("make bootstrap-next wraps --next-only and is not shadowed by the pattern rule", async () => {
  const stdout = await makeDryRun("bootstrap-next");
  assert.match(stdout, /npm run bootstrap:self-host -- --next-only/);
});

test("make bootstrap-146 passes the numeric suffix through as --issue 146", async () => {
  const stdout = await makeDryRun("bootstrap-146");
  assert.match(stdout, /npm run bootstrap:self-host -- --issue 146/);
});

test("make bootstrap-abc rejects a non-numeric issue suffix", async () => {
  await assert.rejects(
    exec("make", ["bootstrap-abc"], { cwd: packageRoot, encoding: "utf8" }),
    /is not a valid issue number/,
  );
});

test("make check still wraps typecheck and test", async () => {
  const stdout = await makeDryRun("check");
  assert.match(stdout, /npm run typecheck/);
  assert.match(stdout, /npm test/);
});

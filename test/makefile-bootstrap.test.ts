import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A recursive `make release-*` invocation (e.g. `$(MAKE) release RELEASE_LEVEL=minor`)
// exports its variable overrides to child processes via MAKEFLAGS/MAKELEVEL. Since this
// suite can itself run nested inside such an invocation (via `npm test`), spawning `make`
// here without stripping those must not let the outer release leak into these assertions.
const cleanEnv = { ...process.env };
delete cleanEnv.MAKEFLAGS;
delete cleanEnv.MFLAGS;
delete cleanEnv.MAKELEVEL;
delete cleanEnv.RELEASE_LEVEL;
delete cleanEnv.RELEASE_NOTES;
delete cleanEnv.RELEASE_FLAGS;

async function makeDryRun(target: string): Promise<string> {
  const result = await exec("make", ["-n", target], { cwd: packageRoot, encoding: "utf8", env: cleanEnv });
  return result.stdout;
}

test("make help lists the release and bootstrap commands", async () => {
  const result = await exec("make", ["help"], { cwd: packageRoot, encoding: "utf8", env: cleanEnv });
  assert.match(result.stdout, /make release \[notes\.\.\.\]\s+Test, auto-note, bump, commit, tag, and push a release/);
  assert.match(result.stdout, /RELEASE_NOTES="\.\.\."/);
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
    exec("make", ["bootstrap-abc"], { cwd: packageRoot, encoding: "utf8", env: cleanEnv }),
    /is not a valid issue number/,
  );
});

test("make release passes empty release notes by default", async () => {
  const stdout = await makeDryRun("release");
  assert.match(stdout, /RELEASE_NOTES="" npm run release -- patch --push/);
});

test("make release treats extra goals as release-note text", async () => {
  const result = await exec("make", ["-n", "release", "Ship", "release", "notes"], { cwd: packageRoot, encoding: "utf8", env: cleanEnv });
  assert.match(result.stdout, /RELEASE_NOTES="Ship release notes" npm run release -- patch --push/);
});

test("make check still wraps typecheck and test", async () => {
  const stdout = await makeDryRun("check");
  assert.match(stdout, /npm run typecheck/);
  assert.match(stdout, /npm test/);
});

test("make lint wraps build and lint only, without tests", async () => {
  const stdout = await makeDryRun("lint");
  assert.match(stdout, /npm run build/);
  assert.match(stdout, /npm run lint/);
  assert.doesNotMatch(stdout, /npm test/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-file-size-"));
  await mkdir(join(root, "src"), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("file-size check reports oversized TypeScript paths and line counts", async () => {
  const state = await fixture();
  try {
    const file = join(state.root, "src", "large.ts");
    await writeFile(file, Array.from({ length: 301 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n");
    await writeFile(join(state.root, "allow.json"), "{}\n");

    await assert.rejects(
      exec("node", [join(process.cwd(), "scripts/check-file-size.mjs"), "--allowlist", join(state.root, "allow.json"), "src"], { cwd: state.root, encoding: "utf8" }),
      (error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        assert.match(stderr, /src\/large\.ts: 301 lines/);
        return true;
      },
    );
  } finally {
    await state.cleanup();
  }
});

test("file-size check accepts explicit reviewable exceptions", async () => {
  const state = await fixture();
  try {
    await writeFile(join(state.root, "src", "large.ts"), "// line\n".repeat(301));
    await writeFile(join(state.root, "allow.json"), JSON.stringify({
      "src/large.ts": "cohesive generated test fixture for allowlist behavior",
    }) + "\n");

    const result = await exec("node", [join(process.cwd(), "scripts/check-file-size.mjs"), "--allowlist", join(state.root, "allow.json"), "src"], { cwd: state.root, encoding: "utf8" });
    assert.equal(result.stderr, "");
  } finally {
    await state.cleanup();
  }
});

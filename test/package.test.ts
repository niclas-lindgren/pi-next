import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readPackageManifest(): Promise<{
  dependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}> {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    files?: string[];
    peerDependencies?: Record<string, string>;
    pi?: { extensions?: string[] };
  };
}

test("the package manifest exposes only the pi-next entry extension", async () => {
  const manifest = await readPackageManifest();

  assert.deepEqual(manifest.pi?.extensions, ["./extensions/pi-next.ts"]);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
  assert.ok(manifest.files?.includes("extensions"));
  assert.ok(manifest.files?.includes("package.json"));
});

test("a disposable consumer can install the package with Pi's local lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-package-test-"));
  const consumer = join(root, "consumer");
  const pi = join(packageRoot, "node_modules", ".bin", "pi");

  try {
    await mkdir(consumer, { recursive: true });
    await exec("git", ["-C", consumer, "init", "--initial-branch=main"]);
    await exec(pi, ["install", "-l", packageRoot, "--approve"], { cwd: consumer });

    const settingsPath = join(consumer, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      packages?: string[];
    };
    assert.equal(settings.packages?.length, 1);
    assert.equal(resolve(dirname(settingsPath), settings.packages![0]), packageRoot);

    const consumerState = join(consumer, ".pi", "runtime", "consumer-state.json");
    await mkdir(dirname(consumerState), { recursive: true });
    await writeFile(consumerState, '{"ownedBy":"consumer"}\n');
    await exec(pi, ["remove", packageRoot, "-l", "--approve"], { cwd: consumer });
    await assert.doesNotReject(() => readFile(consumerState));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { DefaultResourceLoader } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function loadPackageExtensions(consumer: string, agentDir: string) {
  const settings = SettingsManager.create(consumer, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd: consumer, agentDir, settingsManager: settings });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.match(result.extensions[0]!.resolvedPath, /extensions[\\/]pi-next\.ts$/);
  return result.extensions[0]!;
}

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
  assert.ok(manifest.files?.includes("SECURITY.md"));
  assert.ok(manifest.files?.includes("CONTRIBUTING.md"));
  assert.ok(manifest.files?.includes("CHANGELOG.md"));
  assert.ok(manifest.files?.includes("docs"));
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

test("a fresh consumer installs, loads, reproduces, updates, and removes an exact Git revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-git-package-test-"));
  const packageFixture = join(root, "package");
  const remote = join(root, "pi-next.git");
  const consumer = join(root, "consumer");
  const reproduced = join(root, "reproduced");
  const home = join(root, "home");
  const npmStub = join(root, "npm-stub.mjs");
  const npmLog = join(root, "npm.log");
  const sshStub = join(root, "ssh-stub.sh");
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousRemote = process.env.PI_NEXT_TEST_REMOTE;
  const previousNpmLog = process.env.PI_NEXT_NPM_LOG;

  try {
    await cp(packageRoot, packageFixture, {
      recursive: true,
      filter: (source) => !source.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".pi"),
    });
    await mkdir(join(packageFixture, "extensions"), { recursive: true });
    await writeFile(join(packageFixture, "extensions", "unrelated.ts"), "export default function unrelated() {}\n");
    await exec("git", ["init", "--initial-branch=main", packageFixture]);
    await git(packageFixture, "config", "user.email", "test@example.invalid");
    await git(packageFixture, "config", "user.name", "pi-next test");
    await git(packageFixture, "add", ".");
    await git(packageFixture, "commit", "-m", "fixture revision one");
    const revisionOne = await git(packageFixture, "rev-parse", "HEAD");

    await exec("git", ["init", "--bare", remote]);
    await git(packageFixture, "remote", "add", "origin", remote);
    await git(packageFixture, "push", "origin", "main");
    await mkdir(join(consumer, ".pi"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(npmStub, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.PI_NEXT_NPM_LOG || "", process.argv.slice(2).join(" ") + "\\n");\n');
    await writeFile(sshStub, '#!/bin/sh\nexec git-upload-pack "$PI_NEXT_TEST_REMOTE"\n');
    await chmod(sshStub, 0o755);
    process.env.GIT_SSH_COMMAND = sshStub;
    process.env.PI_NEXT_TEST_REMOTE = remote;
    process.env.PI_NEXT_NPM_LOG = npmLog;
    await writeFile(
      join(consumer, ".pi", "settings.json"),
      JSON.stringify({ npmCommand: [process.execPath, npmStub] }, null, 2),
    );
    await exec("git", ["init", "--initial-branch=main", consumer]);
    const sourceOne = `git:git@127.0.0.1:repo/pi-next.git@${revisionOne}`;
    const pi = join(packageRoot, "node_modules", ".bin", "pi");
    const env = { ...process.env, HOME: home };

    await exec(pi, ["install", "-l", sourceOne, "--approve"], { cwd: consumer, env });
    const settingsOne = JSON.parse(await readFile(join(consumer, ".pi", "settings.json"), "utf8")) as {
      packages?: string[];
    };
    assert.deepEqual(settingsOne.packages, [sourceOne]);
    const installedPackage = join(consumer, ".pi", "git", "127.0.0.1", "repo", "pi-next");
    assert.equal(await git(installedPackage, "rev-parse", "HEAD"), revisionOne);
    const loaded = await loadPackageExtensions(consumer, join(home, ".pi", "agent"));
    assert.equal(loaded.sourceInfo.origin, "package");

    await mkdir(join(reproduced, ".pi"), { recursive: true });
    await cp(join(consumer, ".pi", "settings.json"), join(reproduced, ".pi", "settings.json"));
    await exec("git", ["init", "--initial-branch=main", reproduced]);
    const reproducedLoaded = await loadPackageExtensions(reproduced, join(home, ".pi", "agent"));
    assert.equal(reproducedLoaded.sourceInfo.origin, "package");
    assert.match(await readFile(npmLog, "utf8"), /install/);
    assert.equal(await git(join(reproduced, ".pi", "git", "127.0.0.1", "repo", "pi-next"), "rev-parse", "HEAD"), revisionOne);

    await writeFile(join(packageFixture, "revision.txt"), "revision two\n");
    await git(packageFixture, "add", "revision.txt");
    await git(packageFixture, "commit", "-m", "fixture revision two");
    const revisionTwo = await git(packageFixture, "rev-parse", "HEAD");
    await git(packageFixture, "push", "origin", "main");
    const sourceTwo = `git:git@127.0.0.1:repo/pi-next.git@${revisionTwo}`;

    await exec(pi, ["install", "-l", sourceTwo, "--approve"], { cwd: consumer, env });
    assert.equal(await git(installedPackage, "rev-parse", "HEAD"), revisionTwo);
    assert.equal((JSON.parse(await readFile(join(consumer, ".pi", "settings.json"), "utf8")) as { packages?: string[] }).packages?.[0], sourceTwo);
    await loadPackageExtensions(consumer, join(home, ".pi", "agent"));

    const consumerState = join(consumer, ".pi", "runtime", "consumer-state.json");
    await mkdir(dirname(consumerState), { recursive: true });
    await writeFile(consumerState, '{"ownedBy":"consumer"}\n');
    await exec(pi, ["remove", sourceTwo, "-l", "--approve"], { cwd: consumer, env });
    assert.deepEqual((JSON.parse(await readFile(join(consumer, ".pi", "settings.json"), "utf8")) as { packages?: string[] }).packages, []);
    await assert.doesNotReject(() => readFile(consumerState));
  } finally {
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousRemote === undefined) delete process.env.PI_NEXT_TEST_REMOTE;
    else process.env.PI_NEXT_TEST_REMOTE = previousRemote;
    if (previousNpmLog === undefined) delete process.env.PI_NEXT_NPM_LOG;
    else process.env.PI_NEXT_NPM_LOG = previousNpmLog;
    await rm(root, { recursive: true, force: true });
  }
});

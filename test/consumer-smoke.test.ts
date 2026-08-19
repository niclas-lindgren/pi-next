import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(packageRoot, "examples", "consumer-fixture");
const pi = join(packageRoot, "node_modules", ".bin", "pi");
const tsx = join(packageRoot, "node_modules", ".bin", "tsx");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

/**
 * This file is deliberately a test harness, not part of the consumer fixture.
 * It imports coordination code from the installed package path only.
 */
test("fresh consumer installs a pinned package and completes a disposable transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-consumer-smoke-"));
  const packageFixture = join(root, "package");
  const packageRemote = join(root, "pi-next.git");
  const consumer = join(root, "consumer");
  const consumerRemote = join(root, "consumer-origin.git");
  const home = join(root, "home");
  const sshStub = join(root, "ssh-stub.sh");
  const runner = join(root, "runner.mts");
  const activationRunner = join(root, "activation-runner.mts");
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousRemote = process.env.PI_NEXT_TEST_REMOTE;

  try {
    await cp(packageRoot, packageFixture, {
      recursive: true,
      filter: (source) => !source.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".pi"),
    });
    await exec("git", ["init", "--initial-branch=main", packageFixture]);
    await git(packageFixture, "config", "user.email", "test@example.invalid");
    await git(packageFixture, "config", "user.name", "pi-next consumer test");
    await git(packageFixture, "add", ".");
    await git(packageFixture, "commit", "-m", "consumer smoke package");
    const revision = await git(packageFixture, "rev-parse", "HEAD");
    await exec("git", ["init", "--bare", packageRemote]);
    await git(packageFixture, "remote", "add", "origin", packageRemote);
    await git(packageFixture, "push", "origin", "main");

    await cp(fixtureRoot, consumer, { recursive: true });
    await exec("git", ["init", "--initial-branch=main", consumer]);
    await git(consumer, "config", "user.email", "test@example.invalid");
    await git(consumer, "config", "user.name", "pi-next consumer test");
    await exec("git", ["init", "--bare", consumerRemote]);
    await git(consumer, "remote", "add", "origin", consumerRemote);
    await git(consumer, "add", ".");
    await git(consumer, "commit", "-m", "consumer-owned fixture");
    await git(consumer, "push", "origin", "main");
    const cleanBefore = await git(consumer, "status", "--porcelain");
    assert.equal(cleanBefore, "");

    await writeFile(sshStub, "#!/bin/sh\nexec git-upload-pack \"$PI_NEXT_TEST_REMOTE\"\n");
    await exec("chmod", ["+x", sshStub]);
    process.env.GIT_SSH_COMMAND = sshStub;
    process.env.PI_NEXT_TEST_REMOTE = packageRemote;
    const env = { ...process.env, HOME: home };
    await mkdir(home, { recursive: true });
    const source = `git:git@127.0.0.1:repo/pi-next.git@${revision}`;
    await exec(pi, ["install", "-l", source, "--approve"], { cwd: consumer, env });
    const installed = join(consumer, ".pi", "git", "127.0.0.1", "repo", "pi-next");
    assert.equal(await git(installed, "rev-parse", "HEAD"), revision);
    assert.equal((JSON.parse(await readFile(join(consumer, ".pi", "settings.json"), "utf8")) as { packages: string[] }).packages[0], source);
    await git(consumer, "add", ".pi/settings.json");
    await git(consumer, "commit", "-m", "pin pi-next package");
    assert.equal((await exec("find", [consumer, "-path", "*/.pi/extensions/pi-next*", "-print"], { encoding: "utf8" })).stdout.trim(), "");

    // A fresh Pi loader process is the activation boundary: no in-process
    // loader shortcut can make a copied extension appear active.
    await writeFile(activationRunner, `
      import { DefaultResourceLoader } from ${JSON.stringify(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js"))};
      import { SettingsManager } from ${JSON.stringify(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"))};
      import { piNextRuntimeIdentity } from ${JSON.stringify(join(installed, "src/version.ts"))};
      const cwd = process.cwd();
      const settings = SettingsManager.create(cwd, process.env.HOME + "/.pi/agent", { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.HOME + "/.pi/agent", settingsManager: settings });
      await loader.reload();
      const loaded = loader.getExtensions();
      if (loaded.errors.length || loaded.extensions.length !== 1 || loaded.extensions[0].sourceInfo.origin !== "package") throw new Error(JSON.stringify(loaded.errors));
      console.log(JSON.stringify({ extension: loaded.extensions[0].resolvedPath, origin: loaded.extensions[0].sourceInfo.origin, identity: piNextRuntimeIdentity() }));
    `);
    const activation = await exec(tsx, [activationRunner], { cwd: consumer, env });
    const activated = JSON.parse(activation.stdout.trim()) as { extension: string; origin: string; identity: { version: string; revision: string } };
    assert.equal(activated.origin, "package");
    assert.match(activated.extension, /extensions[\\/]pi-next\.ts$/);
    assert.deepEqual(activated.identity, { version: "0.1.0", revision });

    await writeFile(runner, `
      import { InMemoryWorkAuthority, claimIssueLease, ensureIssueWorktree, releaseIssueLease } from ${JSON.stringify(join(installed, "src", "coordination", "index.ts"))};
      import { readFile, writeFile } from "node:fs/promises";
      const cwd = process.cwd();
      const authority = new InMemoryWorkAuthority([{ id: "41", number: 41, title: "fixture work", body: "bounded transition", state: "open", priority: "P1", states: ["open"], comments: [] }]);
      const config = JSON.parse(await readFile(".pi-next/config.json", "utf8"));
      const candidates = await authority.listCandidates(config);
      if (candidates.length !== 1) throw new Error("discovery failed");
      const leases = { lease: undefined, async read() { return this.lease; }, async create(_issue, lease) { if (this.lease) throw new Error("already leased"); this.lease = lease; }, async replace(_issue, expected, lease) { if (this.lease !== expected) throw new Error("compare-and-swap failed"); this.lease = lease; }, async remove(_issue, expected) { if (this.lease !== expected) throw new Error("compare-and-swap failed"); this.lease = undefined; } };
      const now = new Date();
      const lease = await claimIssueLease(leases, { issueNumber: 41, agent: "pi-next", runId: "smoke-run", sessionId: "smoke-session", acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() }, now);
      const workspace = await ensureIssueWorktree(cwd, 41);
      await writeFile(workspace + "/.pi-next-PLAN.md", "issue=41\\nstate=checkpointed\\n");
      const recovered = (await leases.read(41))?.runId === "smoke-run";
      await releaseIssueLease(leases, lease);
      await authority.close("41", "consumer smoke completed");
      const closed = (await authority.get("41")).state === "closed";
      console.log(JSON.stringify({ discovered: candidates[0].id, claimed: lease.runId, workspace, recovered, closed }));
    `);
    const transition = await exec(tsx, [runner], { cwd: consumer, env });
    const result = JSON.parse(transition.stdout.trim()) as { discovered: string; claimed: string; recovered: boolean; closed: boolean; workspace: string };
    assert.deepEqual({ discovered: result.discovered, claimed: result.claimed, recovered: result.recovered, closed: result.closed }, { discovered: "41", claimed: "smoke-run", recovered: true, closed: true });
    assert.match(result.workspace, /\.worktrees[\\/]issue-41$/);
    assert.equal(await git(consumer, "status", "--porcelain"), "");
    assert.equal(await git(consumer, "remote", "get-url", "origin"), consumerRemote);
    assert.doesNotMatch(consumerRemote, /github\.com|gitlab\.com|bitbucket\.org/i);
    assert.equal(await readFile(join(result.workspace, ".pi-next-PLAN.md"), "utf8"), "issue=41\nstate=checkpointed\n");
  } finally {
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousRemote === undefined) delete process.env.PI_NEXT_TEST_REMOTE;
    else process.env.PI_NEXT_TEST_REMOTE = previousRemote;
    await rm(root, { recursive: true, force: true });
  }
});

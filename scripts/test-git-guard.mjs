import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const realGit = process.env.PI_NEXT_TEST_REAL_GIT;
const sourceRoot = process.env.PI_NEXT_TEST_SOURCE_ROOT;
const fixtureRoot = process.env.PI_NEXT_TEST_TMP_ROOT;
const safeSsh = process.env.PI_NEXT_TEST_SAFE_SSH;

if (!realGit || !sourceRoot || !fixtureRoot || !safeSsh) {
  console.error("pi-next test Git safety: guard invoked without safety environment");
  process.exit(97);
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const canonicalSourceRoot = canonical(sourceRoot);
const canonicalFixtureRoot = canonical(fixtureRoot);
const canonicalSafeSsh = canonical(safeSsh);

function inside(root, path) {
  const rel = relative(root, canonical(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function reject(message) {
  console.error(`pi-next test Git safety: refusing ${message}`);
  process.exit(96);
}

function capture(args, cwd = process.cwd()) {
  return spawnSync(realGit, args, { cwd, encoding: "utf8", env: process.env });
}

function parseInvocation(args) {
  let cwd = process.cwd();
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C") {
      const next = args[index + 1];
      if (!next) reject("git -C without a path");
      cwd = resolve(cwd, next);
      index += 2;
      continue;
    }
    if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=") || arg.startsWith("--config-env=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return { cwd, command: arg, commandArgs: args.slice(index + 1) };
  }
  return { cwd, command: undefined, commandArgs: [] };
}

function repoIdentity(cwd) {
  const top = capture(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status === 0 && top.stdout.trim()) return canonical(top.stdout.trim());
  const gitDir = capture(["-C", cwd, "rev-parse", "--absolute-git-dir"]);
  if (gitDir.status === 0 && gitDir.stdout.trim()) return canonical(gitDir.stdout.trim());
  reject(`mutation outside a resolvable disposable Git repository (cwd=${cwd})`);
}

function assertFixturePath(path, label) {
  const value = canonical(path);
  if (value === canonicalSourceRoot || inside(canonicalSourceRoot, value)) {
    reject(`${label} in the real source checkout (${value})`);
  }
  if (!inside(canonicalFixtureRoot, value)) {
    reject(`${label} outside the disposable fixture root ${canonicalFixtureRoot} (${value})`);
  }
}

function assertFixtureRepo(cwd, command) {
  const identity = repoIdentity(cwd);
  assertFixturePath(identity, `${command} repository`);
  return identity;
}

function positional(args) {
  return args.filter((arg) => !arg.startsWith("-"));
}

function remoteNames(cwd) {
  const result = capture(["-C", cwd, "remote"]);
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function resolveRemoteUrls(cwd, remote) {
  if (remote && remoteNames(cwd).includes(remote)) {
    const result = capture(["-C", cwd, "remote", "get-url", "--all", remote]);
    if (result.status !== 0) reject(`unresolvable remote ${remote}`);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (remote) return [remote];
  const names = remoteNames(cwd);
  if (names.length !== 1) reject(`implicit remote with ${names.length} configured remotes`);
  return resolveRemoteUrls(cwd, names[0]);
}

function syntheticLoopbackFixtureRemote(remote) {
  const match = remote.match(/^[^/\\]+@(127\.0\.0\.1|localhost):.+$/i);
  if (!match) return false;
  const fixtureRemote = process.env.PI_NEXT_TEST_REMOTE;
  if (!fixtureRemote) reject(`loopback remote ${remote} without PI_NEXT_TEST_REMOTE fixture binding`);
  assertFixturePath(fixtureRemote, "loopback fixture remote");
  assertFixturePath(canonicalSafeSsh, "safe SSH bridge");
  return true;
}

function localRemotePath(cwd, remote) {
  if (remote.startsWith("file://")) {
    try {
      return fileURLToPath(remote);
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return undefined;
  if (/^[^/\\]+@[^:]+:/i.test(remote)) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(remote)) return remote;
  return isAbsolute(remote) ? remote : resolve(cwd, remote);
}

function assertFixtureRemote(cwd, remote, operation) {
  const urls = resolveRemoteUrls(cwd, remote);
  if (urls.length === 0) reject(`${operation} with no resolvable remote`);
  for (const url of urls) {
    if (syntheticLoopbackFixtureRemote(url)) continue;
    const path = localRemotePath(cwd, url);
    if (!path || /github\.com|gitlab\.com|bitbucket\.org/i.test(url)) {
      reject(`${operation} to non-fixture remote ${url}`);
    }
    assertFixturePath(path, `${operation} remote`);
  }
}

function firstRepositoryArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-q" || arg === "--quiet" || arg === "-f" || arg === "--force" || arg === "-u" || arg === "--set-upstream" || arg === "--tags" || arg === "--prune" || arg.startsWith("--force-with-lease")) continue;
    if (arg === "--repo" || arg === "--upload-pack" || arg === "--receive-pack" || arg === "--depth" || arg === "--filter") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function isConfigRead(args) {
  return args.some((arg) => ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--name-only"].includes(arg));
}

function isBranchRead(args) {
  if (args.length === 0) return true;
  return args.some((arg) => ["--show-current", "--list", "-l", "-r", "--remotes", "-a", "--all", "--contains", "--merged", "--no-merged", "--format"].includes(arg));
}

function isTagRead(args) {
  return args.length === 0 || args.some((arg) => ["--list", "-l", "--contains", "--points-at", "--format"].includes(arg));
}

function validate(args) {
  const { cwd, command, commandArgs } = parseInvocation(args);
  if (!command) return { syntheticSsh: false };

  if (command === "init") {
    const targets = positional(commandArgs);
    const target = targets.at(-1) ?? cwd;
    assertFixturePath(resolve(cwd, target), "git init target");
    return { syntheticSsh: false };
  }

  if (command === "clone") {
    const targets = positional(commandArgs);
    const source = targets[0];
    if (!source) reject("clone without source");
    const destination = targets[1] ?? resolve(cwd, source.replace(/\/$/, "").split(/[\\/]/).at(-1)?.replace(/\.git$/, "") || "clone");
    assertFixturePath(resolve(cwd, destination), "clone destination");
    assertFixtureRemote(cwd, source, "clone");
    return { syntheticSsh: syntheticLoopbackFixtureRemote(source) };
  }

  const alwaysMutating = new Set([
    "add", "commit", "rm", "mv", "merge", "rebase", "reset", "clean", "switch", "checkout",
    "cherry-pick", "revert", "am", "apply", "stash", "update-ref", "fetch", "pull", "gc", "prune",
  ]);
  let mutating = alwaysMutating.has(command);
  if (command === "branch") mutating = !isBranchRead(commandArgs);
  if (command === "tag") mutating = !isTagRead(commandArgs);
  if (command === "config") mutating = !isConfigRead(commandArgs);
  if (command === "worktree") mutating = (commandArgs[0] ?? "list") !== "list";
  if (command === "remote") mutating = ![undefined, "-v", "--verbose", "get-url", "show"].includes(commandArgs[0]);
  if (command === "push") mutating = true;

  if (mutating) assertFixtureRepo(cwd, command);

  if (command === "worktree" && ["add", "move"].includes(commandArgs[0] ?? "")) {
    const target = firstRepositoryArgument(commandArgs.slice(1));
    if (target) assertFixturePath(resolve(cwd, target), `worktree ${commandArgs[0]} target`);
  }

  if (command === "remote" && ["add", "set-url"].includes(commandArgs[0] ?? "")) {
    const url = commandArgs.at(-1);
    if (url) assertFixtureRemote(cwd, url, `remote ${commandArgs[0]}`);
  }

  let syntheticSsh = false;
  if (["push", "fetch", "pull", "ls-remote"].includes(command)) {
    assertFixtureRepo(cwd, command);
    const remote = firstRepositoryArgument(commandArgs);
    assertFixtureRemote(cwd, remote, command);
    syntheticSsh = Boolean(remote && syntheticLoopbackFixtureRemote(remote));
  }
  return { syntheticSsh };
}

const validation = validate(process.argv.slice(2));
const childEnv = validation.syntheticSsh
  ? { ...process.env, GIT_SSH_COMMAND: canonicalSafeSsh }
  : process.env;
const result = spawnSync(realGit, process.argv.slice(2), { stdio: "inherit", env: childEnv });
if (result.error) {
  console.error(result.error.message);
  process.exit(95);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

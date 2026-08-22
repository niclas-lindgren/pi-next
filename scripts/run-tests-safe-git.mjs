import { accessSync, chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const sourceRoot = realpathSync(process.cwd());
const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const guardPath = join(scriptDir, "test-git-guard.mjs");

function findGit() {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error("Unable to locate the real git executable for the test safety harness");
}

function testFiles(args) {
  if (!args.includes("--all")) return args;
  return readdirSync(join(sourceRoot, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join("test", name));
}

const requested = testFiles(process.argv.slice(2));
if (requested.length === 0) throw new Error("No test files supplied to safe Git test runner");

const realGit = findGit();
const wrapperDir = mkdtempSync(join(tmpdir(), "pi-next-safe-git-"));
const wrapperName = process.platform === "win32" ? "git.cmd" : "git";
const wrapperPath = join(wrapperDir, wrapperName);
const sshBridge = join(wrapperDir, process.platform === "win32" ? "fixture-ssh.cmd" : "fixture-ssh");

try {
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${guardPath}" %*\r\n`);
    writeFileSync(sshBridge, `@echo off\r\n"%PI_NEXT_TEST_REAL_GIT%" upload-pack "%PI_NEXT_TEST_REMOTE%"\r\n`);
  } else {
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${guardPath}" "$@"\n`);
    writeFileSync(sshBridge, '#!/bin/sh\nexec "$PI_NEXT_TEST_REAL_GIT" upload-pack "$PI_NEXT_TEST_REMOTE"\n');
    chmodSync(wrapperPath, 0o755);
    chmodSync(sshBridge, 0o755);
  }

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", ...requested],
    {
      cwd: sourceRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`,
        PI_NEXT_TEST_REAL_GIT: realGit,
        PI_NEXT_TEST_SOURCE_ROOT: sourceRoot,
        PI_NEXT_TEST_TMP_ROOT: realpathSync(tmpdir()),
        PI_NEXT_TEST_SAFE_SSH: sshBridge,
      },
    },
  );
  if (child.error) throw child.error;
  if (child.signal) {
    console.error(`test process terminated by ${child.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = child.status ?? 1;
  }
} finally {
  rmSync(wrapperDir, { recursive: true, force: true });
}

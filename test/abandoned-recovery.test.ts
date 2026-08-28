import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  issueWorkspaceIdentity,
  reconcileIssueLeaseForResume,
  LeaseConflictError,
  type IssueLease,
  type IssueLeaseAuthority,
  DEFAULT_PI_NEXT_CONFIG,
  type PiNextConfig,
} from "../src/coordination/index.ts";
import { recoverableAbandonedAutoRun, registerPiNextCommands } from "../extensions/pi-next/commands-recovery.ts";
import { lifecycleTelemetryFile, recordLifecycleEvent } from "../extensions/pi-next/lifecycle-telemetry.ts";
import { emptyLoopMetrics, listLoopStates, loopStateFile, readLoopState, type LoopState } from "../extensions/pi-next/loop-state.ts";

const exec = promisify(execFile);

class MemoryAuthority implements IssueLeaseAuthority {
  constructor(private current?: IssueLease) {}

  async read(): Promise<IssueLease | undefined> {
    return this.current;
  }

  async create(_issueNumber: number, lease: IssueLease): Promise<void> {
    if (this.current) throw new Error("compare-and-swap failed");
    this.current = lease;
  }

  async replace(_issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    if (this.current !== expected) throw new Error("compare-and-swap failed");
    this.current = lease;
  }

  async remove(): Promise<void> {
    this.current = undefined;
  }

  value(): IssueLease | undefined {
    return this.current;
  }
}

function lease(overrides: Partial<IssueLease> = {}): IssueLease {
  const identity = issueWorkspaceIdentity(7);
  return {
    version: 1,
    issueNumber: 7,
    agent: "pi-next",
    runId: "abandoned-run",
    sessionId: "abandoned-session",
    branch: identity.branch,
    worktree: identity.worktree,
    acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    ...overrides,
  };
}

function abandonedState(cwd: string, activeLease: IssueLease): LoopState {
  return {
    version: 1,
    runId: activeLease.runId,
    sessionId: activeLease.sessionId,
    requestedIssues: 1,
    remainingIssues: 1,
    step: 1,
    settledStep: 1,
    maxSteps: 20,
    completedIssues: [],
    deferredIssues: [],
    issueMetrics: [],
    status: "interrupted",
    stopRequested: false,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    metrics: emptyLoopMetrics(),
    coordinationCwd: cwd,
    activeIssueNumber: 7,
    activeWorkspace: resolve(cwd, activeLease.worktree),
    activeLease,
  };
}

async function persistState(cwd: string, state: LoopState): Promise<void> {
  await mkdir(join(cwd, ".pi", "runtime", "pi-next-loops", state.runId), { recursive: true });
  await writeFile(loopStateFile(cwd, state.runId), JSON.stringify(state));
}

async function gitMemoryFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-auto-legacy-recovery-"));
  await mkdir(join(cwd, ".pi-next"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "fixture\n");
  await exec("git", ["init", "--initial-branch=main", cwd]);
  await exec("git", ["-C", cwd, "config", "user.email", "abandoned@example.invalid"]);
  await exec("git", ["-C", cwd, "config", "user.name", "abandoned test"]);
  const remote = join(cwd, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["-C", cwd, "remote", "add", "origin", remote]);
  await exec("git", ["-C", cwd, "add", "."]);
  await exec("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  const config = structuredClone(DEFAULT_PI_NEXT_CONFIG) as PiNextConfig;
  config.authority.adapter = "memory";
  await writeFile(join(cwd, ".pi-next", "config.json"), JSON.stringify(config));
  return cwd;
}

async function installFakeGh(cwd: string, activeLease: IssueLease): Promise<string> {
  const bin = join(cwd, "fake-bin");
  await mkdir(bin, { recursive: true });
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const lease = process.env.PI_NEXT_TEST_FAKE_LEASE_JSON;
if (args[0] === "repo" && args[1] === "view") {
  console.log("owner/repo");
} else if (args[0] === "api" && args[1] === "repos/owner/repo/git/ref/leases/issues/7") {
  console.log(JSON.stringify({ sha: "lease-sha" }));
} else if (args[0] === "api" && args[1] === "repos/owner/repo/contents/lease.json?ref=lease-sha") {
  console.log(JSON.stringify({ encoding: "base64", content: Buffer.from(lease || "").toString("base64") }));
} else {
  console.error("unexpected fake gh invocation: " + args.join(" "));
  process.exit(1);
}
`;
  const path = join(bin, "gh");
  await writeFile(path, script);
  await chmod(path, 0o755);
  process.env.PI_NEXT_TEST_FAKE_LEASE_JSON = JSON.stringify(activeLease);
  return bin;
}

function commandContext(cwd: string): {
  ctx: unknown;
  notifications: Array<{ message: string; level: string }>;
} {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ctx: {
      cwd,
      sessionManager: { getSessionId: () => "session-a" },
      ui: {
        notify: (message: string, level: "info" | "warning" | "error") => {
          notifications.push({ message, level });
        },
        setStatus: () => undefined,
      },
      waitForIdle: async () => undefined,
    },
  };
}

test("abandoned discovery admits a matching stale lease but rejects foreign or missing authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-abandoned-recovery-"));
  try {
    const stale = lease();
    await persistState(cwd, abandonedState(cwd, stale));

    const recovered = await recoverableAbandonedAutoRun(cwd, new MemoryAuthority(stale));
    assert.equal(recovered?.runId, stale.runId);
    assert.equal(recovered?.activeIssueNumber, stale.issueNumber);

    const foreign = await recoverableAbandonedAutoRun(
      cwd,
      new MemoryAuthority(lease({ runId: "other-run", sessionId: "other-session" })),
    );
    assert.equal(foreign, undefined);
    assert.equal(await recoverableAbandonedAutoRun(cwd, new MemoryAuthority()), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/pi-next auto silently tombstones abandoned legacy state and starts a fresh automatic run", async () => {
  const cwd = await gitMemoryFixture();
  const originalPath = process.env.PATH;
  const originalLease = process.env.PI_NEXT_TEST_FAKE_LEASE_JSON;
  try {
    const stale = lease();
    await persistState(cwd, abandonedState(cwd, stale));
    await writeFile(
      join(cwd, ".pi", "runtime", "pi-next-loops", stale.runId, "controller.lock"),
      `run_id=${stale.runId}\npid=999999999\n`,
    );
    const fakeBin = await installFakeGh(cwd, stale);
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

    const handlers = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    registerPiNextCommands({
      on: () => undefined,
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        handlers.set(name, command);
      },
    } as never);
    const command = handlers.get("pi-next");
    assert.ok(command);
    const { ctx, notifications } = commandContext(cwd);

    await command.handler("auto", ctx);

    assert.ok(
      !notifications.some((entry) => /legacy pre-migration state/.test(entry.message)),
      "ordinary auto selection must not print the explicit legacy-resume warning",
    );
    assert.ok(readLoopState(cwd, stale.runId)?.autoResumeBlockedAt);
    assert.ok(
      listLoopStates(cwd).some((state) => state.runId !== stale.runId),
      "auto should still create a fresh scheduler run after ignoring legacy state",
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalLease === undefined) delete process.env.PI_NEXT_TEST_FAKE_LEASE_JSON;
    else process.env.PI_NEXT_TEST_FAKE_LEASE_JSON = originalLease;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stale recovery uses CAS takeover and records recovered claim telemetry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-next-stale-lease-"));
  try {
    const stale = lease();
    const authority = new MemoryAuthority(stale);
    const recovered = await reconcileIssueLeaseForResume(
      authority,
      stale,
      new Date(),
      { cwd, recordEvent: recordLifecycleEvent },
    );
    assert.equal(recovered.runId, stale.runId);
    assert.ok(Date.parse(recovered.expiresAt) > Date.now());
    assert.notEqual(authority.value(), stale);

    const telemetry = JSON.parse(await readFile(lifecycleTelemetryFile(cwd), "utf8")) as { events: Array<{ event: string; outcome: string; at?: string }> };
    assert.deepEqual(telemetry.events.at(-1), {
      event: "claim_taken_over",
      issueNumber: 7,
      runId: stale.runId,
      agent: "pi-next",
      branch: stale.branch,
      worktree: stale.worktree,
      outcome: "recovered",
      at: telemetry.events.at(-1)?.at,
    });

    await assert.rejects(
      () => reconcileIssueLeaseForResume(
        new MemoryAuthority(lease({ runId: "foreign-run", sessionId: "foreign-session" })),
        stale,
      ),
      LeaseConflictError,
      "stale foreign ownership must not be reclaimed from local durable state",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

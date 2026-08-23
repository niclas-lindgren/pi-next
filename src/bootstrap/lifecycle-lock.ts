import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type BootstrapLifecycleOperation = "self-host" | "finalize";
export type BootstrapLifecyclePhase = "acquired" | "preflight" | "worker" | "verification" | "finalization" | "cleanup" | string;

export interface BootstrapLifecycleLockRecord {
  version: 1;
  issueNumber: number;
  runId: string;
  pid: number;
  operation: BootstrapLifecycleOperation;
  phase: BootstrapLifecyclePhase;
  startedAt: string;
  heartbeatAt: string;
  cwd: string;
}

export class BootstrapLifecycleLockError extends Error {
  constructor(readonly code: "ACTIVE_OWNER" | "AMBIGUOUS_OWNER" | "LOCK_FAILED", message: string, readonly record?: BootstrapLifecycleLockRecord | unknown) {
    super(message);
    this.name = "BootstrapLifecycleLockError";
  }
}

export interface BootstrapLifecycleLock {
  readonly record: BootstrapLifecycleLockRecord;
  update(phase: BootstrapLifecyclePhase): Promise<void>;
  release(): Promise<void>;
}

function lockBase(root: string, gitCommonDir?: string): string { return join(gitCommonDir ? resolve(gitCommonDir) : join(root, ".git"), "pi-next", "bootstrap-lifecycle"); }
function lockDir(root: string, issueNumber: number, gitCommonDir?: string): string {
  return join(lockBase(root, gitCommonDir), `issue-${issueNumber}.lock`);
}

function recordPath(dir: string): string { return join(dir, "owner.json"); }

function isRecord(value: unknown, issueNumber: number): value is BootstrapLifecycleLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && v.issueNumber === issueNumber && typeof v.runId === "string" && v.runId.length > 0 && typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && (v.operation === "self-host" || v.operation === "finalize") && typeof v.phase === "string" && typeof v.startedAt === "string" && typeof v.heartbeatAt === "string" && typeof v.cwd === "string";
}

async function readRecord(dir: string, issueNumber: number): Promise<BootstrapLifecycleLockRecord> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(recordPath(dir), "utf8")); }
  catch (error) { throw new BootstrapLifecycleLockError("AMBIGUOUS_OWNER", `bootstrap lifecycle lock for #${issueNumber} is unreadable; fail closed`, error); }
  if (!isRecord(parsed, issueNumber)) throw new BootstrapLifecycleLockError("AMBIGUOUS_OWNER", `bootstrap lifecycle lock for #${issueNumber} is malformed; fail closed`, parsed);
  return parsed;
}

function pidAlive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

function formatBlock(issueNumber: number, record: BootstrapLifecycleLockRecord): string {
  return `bootstrap issue #${issueNumber} · BLOCKED · active ${record.operation} owner run=${record.runId} pid=${record.pid} phase=${record.phase} heartbeat=${record.heartbeatAt}`;
}

export async function acquireBootstrapLifecycleLock(input: { root: string; issueNumber: number; operation: BootstrapLifecycleOperation; phase?: BootstrapLifecyclePhase; heartbeatMs?: number; runId?: string; gitCommonDir?: string }): Promise<BootstrapLifecycleLock> {
  const root = resolve(input.root);
  const issueNumber = input.issueNumber;
  const dir = lockDir(root, issueNumber, input.gitCommonDir);
  await mkdir(lockBase(root, input.gitCommonDir), { recursive: true });
  const makeRecord = (): BootstrapLifecycleLockRecord => {
    const now = new Date().toISOString();
    return { version: 1, issueNumber, runId: input.runId ?? randomUUID(), pid: process.pid, operation: input.operation, phase: input.phase ?? "acquired", startedAt: now, heartbeatAt: now, cwd: root };
  };
  let record = makeRecord();
  for (;;) {
    try {
      await mkdir(dir, { recursive: false });
      await writeFile(recordPath(dir), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      break;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") throw new BootstrapLifecycleLockError("LOCK_FAILED", `could not acquire bootstrap lifecycle lock for #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
      const existing = await readRecord(dir, issueNumber);
      const live = pidAlive(existing.pid);
      if (live !== false) throw new BootstrapLifecycleLockError(live === true ? "ACTIVE_OWNER" : "AMBIGUOUS_OWNER", formatBlock(issueNumber, existing), existing);
      await rm(dir, { recursive: true, force: true });
      record = makeRecord();
    }
  }

  let released = false;
  let timer: NodeJS.Timeout | undefined;
  const write = async (phase: BootstrapLifecyclePhase) => {
    if (released) return;
    record = { ...record, phase, heartbeatAt: new Date().toISOString() };
    await writeFile(recordPath(dir), `${JSON.stringify(record, null, 2)}\n`);
  };
  const heartbeatMs = input.heartbeatMs ?? 5_000;
  if (heartbeatMs > 0) timer = setInterval(() => { void write(record.phase); }, heartbeatMs);
  timer?.unref?.();
  return {
    get record() { return record; },
    update: write,
    async release() { if (released) return; released = true; if (timer) clearInterval(timer); await rm(dir, { recursive: true, force: true }); },
  };
}

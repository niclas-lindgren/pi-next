import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";

const MAX_OUTPUT = 32_000;
const MAX_FAILURE_EVIDENCE = 8_000;
const MAX_PACKET_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_PROGRESS_HEARTBEAT_MS = 20_000;
const MAX_CHANGED_FILES = 200;
const CHECKS = ["npm run typecheck", "npm test"] as const;

export type Disposition = "pass" | "repairable-failure" | "blocked";
export type WorkerRole = "implementation" | "repair" | "review";

export type BootstrapProgressPhase = "preflight" | "worktree" | "dependencies" | "issue" | "worker" | "check" | "terminal";
export type BootstrapProgressState = "start" | "ready" | "activity" | "heartbeat" | "pass" | "fail" | "completed";

export interface BootstrapProgressEvent {
  issueNumber: number;
  phase: BootstrapProgressPhase;
  state: BootstrapProgressState;
  role?: WorkerRole;
  command?: string;
  tool?: string;
  model?: string;
  elapsedMs?: number;
  toolCalls?: number;
  detail?: string;
}

export type BootstrapReporter = (event: BootstrapProgressEvent) => void;

export interface IssueComment {
  author?: { login?: string } | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  comments: IssueComment[];
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface WorkerModel {
  provider?: string;
  id?: string;
}

export interface WorkerStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface CandidateState {
  headRevision: string;
  baselineRevision: string;
  originMainRevision: string;
  mergeBaseRevision: string;
  dirty: boolean;
  changedFiles: string[];
  committedChanges: boolean;
  uncommittedChanges: boolean;
  committedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  commitsAheadOfMergeBase: number;
  commitsAheadOfOriginMain: number;
  commitsBehindOriginMain: number;
  behindOriginMain: boolean;
  divergedFromOriginMain: boolean;
}

export interface ReviewerFinding {
  severity: "blocking" | "warning";
  path?: string;
  summary: string;
}

export interface ReviewerResult {
  verdict: "pass" | "findings";
  findings?: ReviewerFinding[];
}

export type DependencyManager = "npm" | "pnpm" | "yarn";

export interface DependencySetupReport {
  manager?: DependencyManager;
  lockfile?: string;
  action: "not-required" | "reused" | "installed";
}

export interface DependencySetupFailure {
  code: "DEPENDENCY_SETUP_FAILED";
}

export interface WorkerSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  abort?(): Promise<void>;
  readonly model?: WorkerModel;
  getSessionStats?: () => (Partial<WorkerStats> & {
    tokens?: Partial<WorkerStats>;
    toolCalls?: number;
  });
}

export interface WorkerFactoryInput {
  cwd: string;
  role: WorkerRole;
  signal: AbortSignal;
}

export type WorkerFactory = (input: WorkerFactoryInput) => Promise<WorkerSession>;

export interface BootstrapDependencies {
  runCommand?: CommandRunner;
  fetchIssue?: (issueNumber: number, cwd: string) => Promise<Issue>;
  createWorker?: WorkerFactory;
  now?: () => Date;
  reporter?: BootstrapReporter;
  heartbeatMs?: number;
}

export interface BootstrapOptions {
  issueNumber: number;
  cwd?: string;
  allowRepair: boolean;
  review: boolean;
  timeoutMs?: number;
  verifyOnly?: boolean;
  signal?: AbortSignal;
}

export interface CheckReport {
  command: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
  passed: boolean;
  failureEvidence?: string;
}

export interface WorkerReport {
  role: WorkerRole;
  disposition: "completed" | "failed" | "cancelled" | "timed_out";
  model?: string;
  durationMs: number;
  toolCalls: number;
  usage?: WorkerStats;
  reason?: string;
  telemetryWarning?: string;
  reviewResult?: ReviewerResult;
}

export interface BootstrapReport {
  issueNumber: number;
  attempts: number;
  start: string;
  end: string;
  disposition: Disposition;
  branch: string;
  worktree: string;
  revision: string;
  baselineRevision: string;
  candidate: CandidateState;
  dependencySetup: DependencySetupReport;
  workerAttempts: WorkerReport[];
  checks: CheckReport[];
  reviewer?: WorkerReport;
  reviewerResult?: ReviewerResult;
  mechanicalPass: boolean;
  reviewPass?: boolean;
  candidateReadyForReview: boolean;
  finalizationReady: boolean;
  failureReason?: string;
}

interface RepositoryState {
  root: string;
  baselineRevision: string;
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

class BootstrapError extends Error {
  readonly code: string;

  constructor(message: string, code = "BOOTSTRAP_FAILED") {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export class BootstrapSetupError extends BootstrapError implements DependencySetupFailure {
  readonly code = "DEPENDENCY_SETUP_FAILED" as const;

  constructor(message: string) {
    super(message, "DEPENDENCY_SETUP_FAILED");
    this.name = "BootstrapSetupError";
  }
}

function bounded(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED_API_KEY]");
}

function redact(value: string): string {
  return bounded(redactSecrets(value));
}

function emitProgress(reporter: BootstrapReporter | undefined, event: BootstrapProgressEvent): void {
  try {
    reporter?.(event);
  } catch {
    // Operator feedback must never alter lifecycle semantics.
  }
}

function progressToolName(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; toolName?: unknown };
  return item.type === "tool_execution_end" && typeof item.toolName === "string" ? item.toolName.slice(0, 80) : undefined;
}

function progressDuration(elapsedMs: number): string {
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${Math.round(elapsedMs / 1_000)}s`;
}

export function formatBootstrapProgress(event: BootstrapProgressEvent): string {
  const parts = [`bootstrap #${event.issueNumber}`, event.phase];
  if (event.role) parts.push(event.role);
  if (event.command) parts.push(event.command);
  if (event.tool) parts.push(`tool=${event.tool}`);
  parts.push(event.state.toUpperCase());
  if (event.model) parts.push(`model=${event.model}`);
  if (event.toolCalls !== undefined) parts.push(`calls=${event.toolCalls}`);
  if (event.elapsedMs !== undefined) parts.push(`elapsed=${progressDuration(event.elapsedMs)}`);
  if (event.detail) parts.push(event.detail.slice(0, 200));
  return parts.join(" · ");
}

export function createCliProgressReporter(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): BootstrapReporter {
  return (event) => write(formatBootstrapProgress(event));
}

function commandLabel(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function appendOutput(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT) return current;
  return `${current}${chunk.toString()}`.slice(0, MAX_OUTPUT);
}

function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between the timeout and the kill attempt.
  }
}

/** Local worker command execution, adapted from mini-SWE-agent's process-group timeout pattern. */
export const runCommand: CommandRunner = async (command, args, options) => {
  const started = Date.now();
  const child = (await import("node:child_process")).spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  let timedOut = false;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  return await new Promise<CommandResult>((resolvePromise) => {
    const finish = (exitCode: number, signal?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", cancel);
      resolvePromise({
        command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
      });
    };
    const cancel = () => {
      cancelled = true;
      killProcessTree(child.pid ?? 0);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = appendOutput(stderr, error.message);
      finish(127);
    });
    child.once("close", (code, signal) => finish(code ?? 1, signal ?? undefined));
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid ?? 0);
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    }
  });
};

function assertCommand(result: CommandResult, description: string): string {
  if (result.exitCode !== 0) {
    const evidence = redact(result.stderr || result.stdout || `exit ${result.exitCode}`);
    throw new BootstrapError(`${description} failed: ${evidence}`);
  }
  return result.stdout.trim();
}

async function git(cwd: string, args: string[], runner: CommandRunner): Promise<string> {
  return assertCommand(await runner("git", ["-C", cwd, ...args], { cwd }), `git ${args.join(" ")}`);
}

async function gitOptional(cwd: string, args: string[], runner: CommandRunner): Promise<CommandResult> {
  return runner("git", ["-C", cwd, ...args], { cwd });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

interface DependencySpec {
  manager: DependencyManager;
  lockfile: string;
  validateArgs: string[];
  installArgs: string[];
}

const DEPENDENCY_STATE_FILE = ".pi-next-dependency-state.json";

async function dependencyFingerprint(cwd: string, lockfile: string): Promise<string> {
  const packageJson = await readFile(resolve(cwd, "package.json"));
  const lock = await readFile(resolve(cwd, lockfile));
  return createHash("sha256").update(packageJson).update("\0").update(lock).digest("hex");
}

async function dependencyState(cwd: string): Promise<{ manager: DependencyManager; lockfile: string; fingerprint: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(resolve(cwd, "node_modules", DEPENDENCY_STATE_FILE), "utf8")) as Partial<{
      manager: DependencyManager;
      lockfile: string;
      fingerprint: string;
    }>;
    if (typeof value.manager !== "string" || typeof value.lockfile !== "string" || typeof value.fingerprint !== "string") return undefined;
    return value as { manager: DependencyManager; lockfile: string; fingerprint: string };
  } catch {
    return undefined;
  }
}

async function recordDependencyState(cwd: string, spec: DependencySpec, fingerprint: string): Promise<void> {
  await writeFile(resolve(cwd, "node_modules", DEPENDENCY_STATE_FILE), JSON.stringify({
    version: 1,
    manager: spec.manager,
    lockfile: spec.lockfile,
    fingerprint,
  }) + "\n");
}

async function dependencySpec(cwd: string): Promise<DependencySpec | undefined> {
  let packageManager: string | undefined;
  try {
    const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as { packageManager?: unknown };
    if (typeof packageJson.packageManager === "string") packageManager = packageJson.packageManager.split("@")[0];
  } catch {
    // A lockfile below is still enough to select a deterministic installer.
  }
  const candidates: Array<[DependencyManager, string, string[], string[]]> = [
    ["npm", "package-lock.json", ["ls", "--all", "--json", "--silent"], ["ci"]],
    ["pnpm", "pnpm-lock.yaml", ["list", "--recursive", "--depth", "Infinity", "--json"], ["install", "--frozen-lockfile"]],
    ["yarn", "yarn.lock", ["check", "--integrity"], ["install", "--frozen-lockfile"]],
  ];
  const ordered = packageManager
    ? [...candidates].sort(([manager]) => manager === packageManager ? -1 : 1)
    : candidates;
  for (const [manager, lockfile, validateArgs, installArgs] of ordered) {
    if (await stat(resolve(cwd, lockfile)).then((entry) => entry.isFile()).catch(() => false)) {
      return { manager, lockfile, validateArgs, installArgs };
    }
  }
  return undefined;
}

async function prepareDependencies(
  cwd: string,
  runner: CommandRunner,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DependencySetupReport> {
  const spec = await dependencySpec(cwd);
  if (!spec) return { action: "not-required" };

  const nodeModules = resolve(cwd, "node_modules");
  const fingerprint = await dependencyFingerprint(cwd, spec.lockfile);
  const recorded = await dependencyState(cwd);
  const reusable = await isDirectory(nodeModules) && !(await isSymlink(nodeModules));
  const sameInputs = recorded?.manager === spec.manager && recorded.lockfile === spec.lockfile && recorded.fingerprint === fingerprint;
  // A legacy installation without our stamp is still reusable only after the
  // package manager mechanically validates the installed tree. Once stamped,
  // a package/lockfile change deterministically bypasses validation and forces
  // an install in this worktree rather than borrowing a parent installation.
  if (reusable && (recorded === undefined || sameInputs)) {
    const validation = await runner(spec.manager, spec.validateArgs, { cwd, timeoutMs, signal });
    if (validation.exitCode === 0) {
      try {
        await recordDependencyState(cwd, spec, fingerprint);
      } catch {
        // The validated installation is still usable; a later run will
        // validate it again if the bounded stamp cannot be written.
      }
      return { manager: spec.manager, lockfile: spec.lockfile, action: "reused" };
    }
  }

  const installed = await runner(spec.manager, spec.installArgs, { cwd, timeoutMs, signal });
  if (installed.exitCode !== 0) {
    const evidence = redact(installed.stderr || installed.stdout || `exit ${installed.exitCode}`);
    throw new BootstrapSetupError(`${spec.manager} dependency setup failed for ${spec.lockfile}: ${evidence}`);
  }
  try {
    await recordDependencyState(cwd, spec, fingerprint);
  } catch {
    // State is an optimization. The successful deterministic install remains
    // authoritative for this run; a later run will validate again.
  }
  return { manager: spec.manager, lockfile: spec.lockfile, action: "installed" };
}

function parseWorktrees(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function prepareRepository(cwd: string, runner: CommandRunner): Promise<RepositoryState> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"], runner);
  const branch = await git(root, ["branch", "--show-current"], runner);
  if (branch !== "main") throw new BootstrapError(`coordination checkout must be on main, found ${branch || "detached HEAD"}`);
  if ((await git(root, ["status", "--porcelain"], runner)) !== "") {
    throw new BootstrapError("coordination checkout is dirty; preserving it and refusing to start");
  }
  if (resolve(cwd).includes(`${resolve(root)}/.worktrees/`)) {
    throw new BootstrapError("bootstrap must be started from the coordination checkout, not an issue worktree");
  }
  const fetched = await runner("git", ["-C", root, "fetch", "origin", "main", "--quiet"], { cwd: root });
  assertCommand(fetched, "fetch origin main");
  const baselineRevision = await git(root, ["rev-parse", "origin/main"], runner);
  const head = await git(root, ["rev-parse", "HEAD"], runner);
  const ancestry = await gitOptional(root, ["merge-base", "--is-ancestor", head, baselineRevision], runner);
  if (ancestry.exitCode !== 0) {
    throw new BootstrapError("local main is not an ancestor of origin/main; refusing to discard or rewrite local work");
  }
  return { root, baselineRevision };
}

async function prepareWorktree(repository: RepositoryState, issueNumber: number, runner: CommandRunner): Promise<{ path: string; branch: string }> {
  const branch = `agent/issue-${issueNumber}`;
  const path = resolve(repository.root, ".worktrees", `issue-${issueNumber}`);
  await mkdir(dirname(path), { recursive: true });
  const entries = parseWorktrees(await git(repository.root, ["worktree", "list", "--porcelain"], runner));
  const registered = entries.find((entry) => resolve(entry.path) === path);
  const pathExists = await isDirectory(path);
  if (pathExists && !registered) throw new BootstrapError(`canonical worktree path exists but is not registered: ${path}`);
  if (registered && registered.branch !== branch) {
    throw new BootstrapError(`canonical worktree has ${registered.branch ?? "no branch"}, expected ${branch}`);
  }
  const branchEntry = entries.find((entry) => entry.branch === branch);
  if (branchEntry && resolve(branchEntry.path) !== path) {
    throw new BootstrapError(`canonical branch ${branch} is checked out at another path: ${branchEntry.path}`);
  }
  if (!registered) {
    const branchExists = (await gitOptional(repository.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], runner)).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", "--quiet", path, branch]
      : ["worktree", "add", "--quiet", "-b", branch, path, repository.baselineRevision];
    assertCommand(await runner("git", ["-C", repository.root, ...args], { cwd: repository.root }), "create canonical worktree");
  }
  const actualBranch = await git(path, ["branch", "--show-current"], runner);
  if (actualBranch !== branch) throw new BootstrapError(`canonical worktree branch mismatch: ${actualBranch}`);
  return { path, branch };
}

function issueFromJson(value: unknown): Issue {
  if (!value || typeof value !== "object") throw new BootstrapError("GitHub returned an invalid issue payload");
  const item = value as Partial<Issue>;
  if (typeof item.number !== "number" || typeof item.title !== "string" || typeof item.body !== "string") {
    throw new BootstrapError("GitHub issue payload is missing number, title, or body");
  }
  return { number: item.number, title: item.title, body: item.body, comments: Array.isArray(item.comments) ? item.comments : [] };
}

export async function fetchIssue(issueNumber: number, cwd: string, runner: CommandRunner = runCommand): Promise<Issue> {
  const result = await runner("gh", ["issue", "view", String(issueNumber), "--json", "number,title,body,comments"], { cwd });
  return issueFromJson(JSON.parse(assertCommand(result, `fetch issue #${issueNumber}`)));
}

function commentText(comment: IssueComment): string {
  const author = comment.author?.login ? `@${comment.author.login}` : "unknown";
  const date = comment.createdAt ?? comment.updatedAt ?? "";
  return `Comment by ${author}${date ? ` (${date})` : ""}:\n${comment.body ?? ""}`;
}

async function loadContextFiles(cwd: string, issue: Issue): Promise<Array<{ path: string; content: string }>> {
  const root = resolve(cwd);
  const agentsPath = resolve(root, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  const references = new Set<string>(["docs/EVALUATION_AND_RELIABILITY.md"]);
  for (const source of [agents, issue.body, ...issue.comments.map((comment) => comment.body ?? "")]) {
    for (const match of source.matchAll(/(?:^|[\s(`])((?:docs|examples)\/[A-Za-z0-9_./-]+\.md)/g)) references.add(match[1]!);
  }
  const files = [{ path: "AGENTS.md", content: agents }];
  for (const relativePath of [...references].sort()) {
    const path = resolve(root, relativePath);
    if (!path.startsWith(`${root}/`) || !(await isDirectory(dirname(path)))) continue;
    try {
      files.push({ path: relativePath, content: await readFile(path, "utf8") });
    } catch {
      throw new BootstrapError(`referenced repository document is missing: ${relativePath}`);
    }
  }
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_PACKET_BYTES) throw new BootstrapError("bounded worker context packet is too large");
  return files;
}

function buildWorkerPrompt(issue: Issue, cwd: string, contextFiles: Array<{ path: string; content: string }>, role: WorkerRole, failureEvidence?: string, candidate?: string): string {
  const comments = issue.comments.length ? issue.comments.map(commentText).join("\n\n") : "(no comments)";
  const context = contextFiles.map((file) => `--- BEGIN ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n");
  const roleInstruction = role === "review"
    ? "Review the exact candidate evidence for correctness and contract violations. Do not edit files, run mutating commands, merge, push, close issues, or claim acceptance. Return only the structured result contract: {\"verdict\":\"pass\"} or {\"verdict\":\"findings\",\"findings\":[{\"severity\":\"blocking\"|\"warning\",\"path\":\"optional\",\"summary\":\"concise bounded finding\"}]}. Do not include transcript, hidden reasoning, or unbounded prose."
    : role === "repair"
      ? "This is one fresh repair attempt. Inspect the current worktree and repair only the reported deterministic failures. Do not merge, push, close the issue, release authority, or grade your own work."
      : "Implement the issue completely in this worktree. Do not merge, push, close the issue, release authority, or grade your own work.";
  const packet = [
    `You are the ${role} worker for pi-next issue #${issue.number}.`,
    roleInstruction,
    `Canonical worktree cwd: ${cwd}`,
    "Use only the supplied worktree. Read the complete issue and repository instructions below.",
    "Run issue-specific checks plus npm run typecheck and npm test when appropriate.",
    "The supervisor runs deterministic verification outside this session; your prose is not acceptance evidence.",
    "The shell capability is intentionally restricted; never attempt GitHub authority or main-branch operations.",
    "\n--- BEGIN ISSUE ---",
    `Title: ${issue.title}\n\n${issue.body}`,
    "--- END ISSUE ---",
    "\n--- BEGIN CURRENT COMMENTS ---",
    comments,
    "--- END CURRENT COMMENTS ---",
    "\n--- BEGIN REPOSITORY CONTEXT ---",
    context,
    "--- END REPOSITORY CONTEXT ---",
  ];
  if (failureEvidence) packet.push("\n--- BEGIN DETERMINISTIC FAILURE EVIDENCE ---", failureEvidence, "--- END DETERMINISTIC FAILURE EVIDENCE ---");
  if (candidate) packet.push("\n--- BEGIN EXACT CANDIDATE EVIDENCE ---", candidate, "--- END EXACT CANDIDATE EVIDENCE ---");
  const prompt = packet.join("\n");
  if (prompt.length > MAX_PACKET_BYTES) throw new BootstrapError("worker task packet is too large");
  return prompt;
}

function forbiddenWorkerCommand(command: string): boolean {
  return /(^|[;&|\n])\s*(?:sudo\s+)?(?:gh(?:\s|$)|git\s+(?:push|merge|reset|rebase|worktree|checkout|switch|update-ref)|git\s+branch\s+-[dD]|rm\s+-rf\s+\.git)/i.test(command)
    || /\bgh\s+(?:issue|pr|api)\b/i.test(command);
}

function makeSafeBashTool(cwd: string, defineToolImpl: (definition: unknown) => unknown) {
  return defineToolImpl({
    name: "safe_bash",
    label: "Safe shell",
    description: "Run a repository command in the canonical worktree. Authority, main-branch, and destructive worktree operations are refused.",
    promptSnippet: "run a safe repository shell command",
    parameters: Type.Object({ command: Type.String({ description: "The command to run" }) }),
    execute: async (_toolCallId: string, params: { command: string }, signal: AbortSignal | undefined) => {
      if (forbiddenWorkerCommand(params.command)) {
        return { content: [{ type: "text", text: "Refused: authority, main-branch, or destructive worktree command." }], details: { refused: true } };
      }
      const result = await runCommand("sh", ["-c", params.command], { cwd, timeoutMs: 30 * 60 * 1_000, signal });
      const output = redact(`${result.stdout}${result.stderr}`);
      return { content: [{ type: "text", text: bounded(`exit ${result.exitCode}\n${output}`) }], details: { exitCode: result.exitCode } };
    },
  });
}

export async function createDefaultWorkerFactory(): Promise<WorkerFactory> {
  const sdk = await import("@earendil-works/pi-coding-agent") as any;
  const modelRuntime = await sdk.ModelRuntime.create();
  return async ({ cwd, role }) => {
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir() || resolve(homedir(), ".pi", "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "You are a bounded plain Pi coding worker. Follow the task packet and never act as lifecycle authority.",
    });
    await loader.reload();
    const readOnly = role === "review";
    const sessionResult = await sdk.createAgentSession({
      cwd,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      tools: readOnly ? ["read", "grep", "find", "ls"] : ["read", "edit", "write", "grep", "find", "ls", "safe_bash"],
      customTools: readOnly ? [] : [makeSafeBashTool(cwd, sdk.defineTool)],
    });
    return sessionResult.session;
  };
}

function extractAssistantTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; assistantMessageEvent?: unknown };
  if (item.type !== "message_update" || !item.assistantMessageEvent || typeof item.assistantMessageEvent !== "object") return undefined;
  const assistantEvent = item.assistantMessageEvent as { type?: unknown; delta?: unknown };
  return assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
}

function parseReviewResultText(text: string | undefined): ReviewerResult | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return sanitizeReviewResult(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function sanitizeReviewResult(value: unknown): ReviewerResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as { verdict?: unknown; findings?: unknown };
  if (item.verdict === "pass") return { verdict: "pass" };
  if (item.verdict !== "findings" || !Array.isArray(item.findings)) return undefined;
  const findings = item.findings.slice(0, 20).map((finding): ReviewerFinding | undefined => {
    if (!finding || typeof finding !== "object") return undefined;
    const raw = finding as { severity?: unknown; path?: unknown; summary?: unknown };
    if (raw.severity !== "blocking" && raw.severity !== "warning") return undefined;
    if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) return undefined;
    const sanitized: ReviewerFinding = { severity: raw.severity, summary: redact(raw.summary).slice(0, 500) };
    if (typeof raw.path === "string" && raw.path.length <= 300 && !raw.path.includes("\0")) sanitized.path = raw.path;
    return sanitized;
  });
  if (findings.some((finding) => finding === undefined)) return undefined;
  return { verdict: "findings", findings: findings as ReviewerFinding[] };
}

function reviewPassed(result: ReviewerResult | undefined): boolean {
  return result?.verdict === "pass" || (result?.verdict === "findings" && !(result.findings ?? []).some((finding) => finding.severity === "blocking"));
}

function workerStats(session: WorkerSession): { toolCalls: number; usage?: WorkerStats; warning?: string } {
  const stats = session.getSessionStats?.();
  if (!stats) return { toolCalls: 0 };
  // Pi >= 0.84 nests token counters under stats.tokens. Keep the flat
  // fallback for older supported SDKs, but prefer the authoritative shape.
  const tokens = stats.tokens ?? stats;
  const usage: WorkerStats = {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    total: tokens.total ?? 0,
    cost: stats.cost ?? 0,
  };
  const hasTokenStats = stats.tokens !== undefined;
  const warning = hasTokenStats && usage.cost > 0 && usage.total === 0
    ? "SDK reported nonzero cost with zero token usage"
    : undefined;
  return { toolCalls: stats.toolCalls ?? 0, usage, warning };
}

async function runWorker(
  factory: WorkerFactory,
  role: WorkerRole,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  reports: WorkerReport[],
  issueNumber: number,
  reporter: BootstrapReporter | undefined,
  heartbeatMs: number,
  parentSignal?: AbortSignal,
): Promise<WorkerReport> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let session: WorkerSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let toolCalls = 0;
  let assistantText = "";
  let model: string | undefined;
  let lastSafeProgress = started;
  let cancelParent: (() => void) | undefined;
  emitProgress(reporter, { issueNumber, phase: "worker", state: "start", role });
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastSafeProgress < heartbeatMs) return;
      emitProgress(reporter, { issueNumber, phase: "worker", state: "heartbeat", role, model, elapsedMs: now - started, toolCalls });
      lastSafeProgress = now;
    }, heartbeatMs);
  }
  try {
    session = await factory({ cwd, role, signal: controller.signal });
    model = session.model?.provider && session.model.id ? `${session.model.provider}/${session.model.id}` : undefined;
    emitProgress(reporter, { issueNumber, phase: "worker", state: "ready", role, model, elapsedMs: Date.now() - started, toolCalls });
    lastSafeProgress = Date.now();
    unsubscribe = session.subscribe((event) => {
      if (typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_execution_end") {
        toolCalls += 1;
        const tool = progressToolName(event);
        emitProgress(reporter, { issueNumber, phase: "worker", state: "activity", role, model, tool, elapsedMs: Date.now() - started, toolCalls });
        lastSafeProgress = Date.now();
      }
      const delta = extractAssistantTextDelta(event);
      if (delta) assistantText = `${assistantText}${delta}`.slice(-16_000);
    });
    const cancellation = new Promise<never>((_, reject) => {
      cancelParent = () => {
        controller.abort();
        reject(new BootstrapError(`worker ${role} cancelled`));
      };
      if (parentSignal?.aborted) cancelParent();
      else parentSignal?.addEventListener("abort", cancelParent, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BootstrapError(`worker ${role} timed out`));
      }, timeoutMs);
    });
    await Promise.race([session.prompt(prompt), timeout, cancellation]);
    const stats = workerStats(session);
    const report: WorkerReport = {
      role,
      disposition: "completed",
      model,
      durationMs: Date.now() - started,
      toolCalls: Math.max(toolCalls, stats.toolCalls),
      usage: stats.usage,
      telemetryWarning: stats.warning,
      reviewResult: role === "review" ? parseReviewResultText(assistantText) : undefined,
    };
    reports.push(report);
    emitProgress(reporter, { issueNumber, phase: "worker", state: "completed", role, model, elapsedMs: report.durationMs, toolCalls: report.toolCalls });
    return report;
  } catch (error) {
    const timedOut = error instanceof BootstrapError && error.message.includes("timed out");
    const cancelled = controller.signal.aborted && !timedOut;
    if (session?.abort) await session.abort().catch(() => undefined);
    const stats = session ? workerStats(session) : { toolCalls };
    const report: WorkerReport = {
      role,
      disposition: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
      model,
      durationMs: Date.now() - started,
      toolCalls: Math.max(toolCalls, stats.toolCalls),
      usage: stats.usage,
      telemetryWarning: stats.warning,
      reason: redact(error instanceof Error ? error.message : String(error)),
    };
    reports.push(report);
    emitProgress(reporter, { issueNumber, phase: "worker", state: "fail", role, model, elapsedMs: report.durationMs, toolCalls: report.toolCalls, detail: report.disposition });
    return report;
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (parentSignal && cancelParent) parentSignal.removeEventListener("abort", cancelParent);
    session?.dispose();
  }
}

async function runChecks(
  cwd: string,
  runner: CommandRunner,
  timeoutMs: number,
  issueNumber: number,
  reporter: BootstrapReporter | undefined,
  heartbeatMs: number,
  signal?: AbortSignal,
): Promise<CheckReport[]> {
  const checks: CheckReport[] = [];
  for (const command of CHECKS) {
    const started = Date.now();
    emitProgress(reporter, { issueNumber, phase: "check", state: "start", command });
    let heartbeat: NodeJS.Timeout | undefined;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        emitProgress(reporter, { issueNumber, phase: "check", state: "heartbeat", command, elapsedMs: Date.now() - started });
      }, heartbeatMs);
    }
    let result: CommandResult;
    try {
      result = await runner("sh", ["-c", command], { cwd, timeoutMs, signal });
    } catch (error) {
      emitProgress(reporter, { issueNumber, phase: "check", state: "fail", command, elapsedMs: Date.now() - started });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    const evidence = result.exitCode === 0 ? undefined : redact(bounded((result.stderr || result.stdout).slice(-MAX_FAILURE_EVIDENCE), MAX_FAILURE_EVIDENCE));
    checks.push({
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      passed: result.exitCode === 0,
      failureEvidence: evidence,
    });
    emitProgress(reporter, { issueNumber, phase: "check", state: result.exitCode === 0 ? "pass" : "fail", command, elapsedMs: result.durationMs });
    if (result.exitCode !== 0) break;
  }
  return checks;
}

function parseStatusLine(line: string): { index: string; worktree: string; path: string; untracked: boolean } | undefined {
  if (!line) return undefined;
  const match = line.match(/^([ MADRCU?!])([ MADRCU?!]) (.+)$/) ?? line.match(/^([MADRCU?!]) (.+)$/);
  if (!match) return { index: " ", worktree: " ", path: line.split(" -> ").at(-1) ?? line, untracked: false };
  const compact = match.length === 3;
  // git() trims the complete output, so a first-line unstaged status like
  // " M file" can arrive as "M file". A true staged entry keeps two status
  // columns ("M  file") and is handled by the non-compact match.
  const index = compact ? " " : match[1]!;
  const worktree = compact ? match[1]! : match[2]!;
  const rawPath = compact ? match[2]! : match[3]!;
  return { index, worktree, path: rawPath.split(" -> ").at(-1) ?? rawPath, untracked: index === "?" && worktree === "?" };
}

function statusEntries(status: string): Array<{ index: string; worktree: string; path: string; untracked: boolean }> {
  return status.split("\n").map(parseStatusLine).filter((entry): entry is NonNullable<ReturnType<typeof parseStatusLine>> => Boolean(entry));
}

function statusFileNames(status: string): string[] {
  return statusEntries(status).map((entry) => entry.path).filter(Boolean);
}

function splitLines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}

async function revCount(cwd: string, range: string, runner: CommandRunner): Promise<number> {
  return Number(await git(cwd, ["rev-list", "--count", range], runner));
}

async function readCandidateState(cwd: string, baselineRevision: string, runner: CommandRunner): Promise<CandidateState> {
  const headRevision = await git(cwd, ["rev-parse", "HEAD"], runner);
  const mergeBaseRevision = await git(cwd, ["merge-base", baselineRevision, headRevision], runner);
  const [status, committedFilesText, stagedFilesText, unstagedFilesText, aheadMerge, aheadMain, behindMain] = await Promise.all([
    git(cwd, ["status", "--short", "--untracked-files=all"], runner),
    git(cwd, ["diff", "--name-only", `${mergeBaseRevision}..${headRevision}`], runner),
    git(cwd, ["diff", "--cached", "--name-only"], runner),
    git(cwd, ["diff", "--name-only"], runner),
    revCount(cwd, `${mergeBaseRevision}..${headRevision}`, runner),
    revCount(cwd, `${baselineRevision}..${headRevision}`, runner),
    revCount(cwd, `${headRevision}..${baselineRevision}`, runner),
  ]);
  const entries = statusEntries(status);
  const committedFiles = splitLines(committedFilesText);
  const stagedFiles = [...new Set([...splitLines(stagedFilesText), ...entries.filter((entry) => entry.index !== " " && !entry.untracked).map((entry) => entry.path)])];
  const unstagedFiles = [...new Set([...splitLines(unstagedFilesText), ...entries.filter((entry) => entry.worktree !== " " && !entry.untracked).map((entry) => entry.path)])];
  const untrackedFiles = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  const changedFiles = [...new Set([
    ...committedFiles,
    ...stagedFiles,
    ...unstagedFiles,
    ...untrackedFiles,
  ])].slice(0, MAX_CHANGED_FILES);
  return {
    headRevision,
    baselineRevision,
    originMainRevision: baselineRevision,
    mergeBaseRevision,
    dirty: status.length > 0,
    changedFiles,
    committedChanges: aheadMerge > 0,
    uncommittedChanges: status.length > 0,
    committedFiles,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    commitsAheadOfMergeBase: aheadMerge,
    commitsAheadOfOriginMain: aheadMain,
    commitsBehindOriginMain: behindMain,
    behindOriginMain: behindMain > 0,
    divergedFromOriginMain: aheadMain > 0 && behindMain > 0,
  };
}

function assertRelativeGitPath(path: string): void {
  if (path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new BootstrapError(`unsafe candidate path in git status: ${path}`);
}

async function untrackedEvidence(cwd: string, files: string[]): Promise<string> {
  if (files.length === 0) return "(none)";
  const sections: string[] = [];
  let total = 0;
  for (const file of files) {
    assertRelativeGitPath(file);
    const absolute = resolve(cwd, file);
    if (!absolute.startsWith(`${resolve(cwd)}/`)) throw new BootstrapError(`unsafe candidate path in git status: ${file}`);
    const entry = await stat(absolute).catch(() => undefined);
    if (!entry?.isFile()) throw new BootstrapError(`untracked candidate path is not a regular text file: ${file}`);
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) throw new BootstrapError(`untracked candidate file cannot be represented as bounded text evidence: ${file}`);
    const content = redactSecrets(bytes.toString("utf8"));
    const section = `--- BEGIN UNTRACKED FILE ${file} ---\n${content}\n--- END UNTRACKED FILE ${file} ---`;
    total += section.length;
    if (total > MAX_PACKET_BYTES) throw new BootstrapError("exact candidate evidence is too large for the bounded reviewer packet");
    sections.push(section);
  }
  return sections.join("\n\n");
}

async function candidateEvidence(cwd: string, baselineRevision: string, revision: string, runner: CommandRunner): Promise<string> {
  const mergeBaseRevision = await git(cwd, ["merge-base", baselineRevision, revision], runner);
  const status = await git(cwd, ["status", "--short", "--untracked-files=all"], runner);
  const untrackedFiles = statusEntries(status).filter((entry) => entry.untracked).map((entry) => entry.path);
  const [committed, staged, unstaged, untracked] = await Promise.all([
    git(cwd, ["diff", "--no-ext-diff", `${mergeBaseRevision}..${revision}`], runner),
    git(cwd, ["diff", "--cached", "--no-ext-diff"], runner),
    git(cwd, ["diff", "--no-ext-diff"], runner),
    untrackedEvidence(cwd, untrackedFiles),
  ]);
  const evidence = [
    `ORIGIN_MAIN: ${baselineRevision}`,
    `REVISION: ${revision}`,
    `MERGE_BASE: ${mergeBaseRevision}`,
    `STATUS:\n${status || "(clean)"}`,
    `COMMITTED DIFF (MERGE_BASE..HEAD):\n${committed || "(none)"}`,
    `STAGED DIFF:\n${staged || "(none)"}`,
    `UNSTAGED DIFF:\n${unstaged || "(none)"}`,
    `UNTRACKED FILE CONTENTS:\n${untracked}`,
  ].join("\n\n");
  if (evidence.length > MAX_PACKET_BYTES) throw new BootstrapError("exact candidate evidence is too large for the bounded reviewer packet");
  return evidence;
}

function failureEvidence(checks: CheckReport[]): string {
  return checks.filter((check) => !check.passed).map((check) => `${check.command} (exit ${check.exitCode}):\n${check.failureEvidence ?? "no output"}`).join("\n\n");
}

export async function runBootstrap(options: BootstrapOptions, dependencies: BootstrapDependencies = {}): Promise<BootstrapReport> {
  const now = dependencies.now ?? (() => new Date());
  const started = now();
  const runner = dependencies.runCommand ?? runCommand;
  const reporter = dependencies.reporter;
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_PROGRESS_HEARTBEAT_MS;
  const cwd = resolve(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "preflight", state: "start" });
  let repository: RepositoryState;
  try {
    repository = await prepareRepository(cwd, runner);
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "preflight", state: "pass" });
  } catch (error) {
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "preflight", state: "fail" });
    throw error;
  }

  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worktree", state: "start" });
  let worktree: { path: string; branch: string };
  try {
    worktree = await prepareWorktree(repository, options.issueNumber, runner);
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worktree", state: "ready", detail: relative(repository.root, worktree.path) || "." });
  } catch (error) {
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worktree", state: "fail" });
    throw error;
  }

  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "dependencies", state: "start" });
  let dependencySetup: DependencySetupReport;
  try {
    dependencySetup = await prepareDependencies(worktree.path, runner, timeoutMs, options.signal);
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "dependencies", state: "ready", detail: dependencySetup.action });
  } catch (error) {
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "dependencies", state: "fail" });
    throw error;
  }

  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "issue", state: "start" });
  let issue: Issue;
  try {
    issue = dependencies.fetchIssue ? await dependencies.fetchIssue(options.issueNumber, repository.root) : await fetchIssue(options.issueNumber, repository.root, runner);
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "issue", state: "ready" });
  } catch (error) {
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "issue", state: "fail" });
    throw error;
  }

  const contextFiles = await loadContextFiles(worktree.path, issue);
  const workerAttempts: WorkerReport[] = [];
  let factory: WorkerFactory | undefined;
  const getFactory = async (): Promise<WorkerFactory> => {
    if (factory) return factory;
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worker", state: "start", detail: "factory" });
    factory = dependencies.createWorker ?? await createDefaultWorkerFactory();
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worker", state: "ready", detail: "factory" });
    return factory;
  };

  let initialWorker: WorkerReport | undefined;
  if (!options.verifyOnly) {
    const initialPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "implementation");
    initialWorker = await runWorker(await getFactory(), "implementation", initialPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
  }
  let checks = await runChecks(worktree.path, runner, timeoutMs, options.issueNumber, reporter, heartbeatMs, options.signal);
  let repairWorker: WorkerReport | undefined;
  const implementationCompleted = options.verifyOnly || initialWorker?.disposition === "completed";
  if (!checks.every((check) => check.passed) && options.allowRepair && implementationCompleted) {
    const repairPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "repair", failureEvidence(checks));
    repairWorker = await runWorker(await getFactory(), "repair", repairPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
    checks = await runChecks(worktree.path, runner, timeoutMs, options.issueNumber, reporter, heartbeatMs, options.signal);
  }
  const candidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
  let reviewer: WorkerReport | undefined;
  if (options.review && implementationCompleted && checks.every((check) => check.passed)) {
    const reviewEvidence = await candidateEvidence(worktree.path, repository.baselineRevision, candidate.headRevision, runner);
    const reviewPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "review", undefined, reviewEvidence);
    reviewer = await runWorker(await getFactory(), "review", reviewPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
  }
  const mechanicalPass = checks.length === CHECKS.length && checks.every((check) => check.passed);
  const reviewerResult = reviewer?.reviewResult;
  const reviewPass = options.review ? reviewer?.disposition === "completed" && reviewPassed(reviewerResult) : undefined;
  const candidateReadyForReview = mechanicalPass;
  const finalizationReady = mechanicalPass && !candidate.dirty && !candidate.behindOriginMain && (options.review ? reviewPass === true : true);
  const disposition: Disposition = !implementationCompleted
    ? "blocked"
    : mechanicalPass
      ? options.review && reviewPass !== true
        ? "blocked"
        : "pass"
      : "repairable-failure";
  const reason = disposition === "pass"
    ? undefined
    : reviewer && reviewPass !== true
      ? "independent review did not return a passing structured verdict"
      : initialWorker?.reason ?? (failureEvidence(checks) || "worker did not complete deterministic verification");
  const report: BootstrapReport = {
    issueNumber: options.issueNumber,
    attempts: workerAttempts.length,
    start: started.toISOString(),
    end: now().toISOString(),
    disposition,
    branch: worktree.branch,
    worktree: relative(repository.root, worktree.path) || ".",
    revision: candidate.headRevision,
    baselineRevision: repository.baselineRevision,
    candidate,
    dependencySetup,
    workerAttempts,
    checks,
    reviewer,
    reviewerResult,
    mechanicalPass,
    reviewPass,
    candidateReadyForReview,
    finalizationReady,
    failureReason: reason,
  };
  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: disposition === "pass" ? "pass" : "fail", detail: disposition });
  return report;
}

function parseArgs(args: string[]): BootstrapOptions {
  let issueNumber: number | undefined;
  let allowRepair = false;
  let review = false;
  let verifyOnly = false;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--issue") issueNumber = Number(args[++index]);
    else if (arg === "--repair") allowRepair = true;
    else if (arg === "--review") review = true;
    else if (arg === "--verify-only" || arg === "--resume") verifyOnly = true;
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (arg === "--queue") throw new BootstrapError("multi-issue --queue mode is intentionally not implemented");
    else throw new BootstrapError(`unknown option: ${arg}`);
  }
  const parsedIssueNumber = issueNumber;
  if (typeof parsedIssueNumber !== "number" || !Number.isInteger(parsedIssueNumber) || parsedIssueNumber <= 0) throw new BootstrapError("--issue N is required");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new BootstrapError("--timeout-ms must be positive");
  return { issueNumber: parsedIssueNumber, allowRepair, review, verifyOnly, timeoutMs };
}

export function exitCodeForDisposition(disposition: Disposition): number {
  return disposition === "pass" ? 0 : disposition === "repairable-failure" ? 1 : 2;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const reporter = createCliProgressReporter();
  let options: BootstrapOptions | undefined;
  try {
    options = parseArgs(args);
    const report = await runBootstrap(options, { reporter });
    console.log(JSON.stringify(report, null, 2));
    return exitCodeForDisposition(report.disposition);
  } catch (error) {
    if (options) emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: "fail", detail: "blocked" });
    console.error(JSON.stringify({
      disposition: "blocked",
      code: error instanceof BootstrapError ? error.code : "BOOTSTRAP_FAILED",
      reason: redact(error instanceof Error ? error.message : String(error)),
    }));
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}

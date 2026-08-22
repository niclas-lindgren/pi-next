import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { Type } from "typebox";

const MAX_OUTPUT = 32_000;
const MAX_FAILURE_EVIDENCE = 8_000;
const MAX_PACKET_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const CHECKS = ["npm run typecheck", "npm test"] as const;

export type Disposition = "pass" | "repairable-failure" | "blocked";
export type WorkerRole = "implementation" | "repair" | "review";

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

export interface WorkerSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  abort?(): Promise<void>;
  readonly model?: WorkerModel;
  getSessionStats?: () => Partial<WorkerStats> & { toolCalls?: number };
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
}

export interface BootstrapOptions {
  issueNumber: number;
  cwd?: string;
  allowRepair: boolean;
  review: boolean;
  timeoutMs?: number;
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
  workerAttempts: WorkerReport[];
  checks: CheckReport[];
  reviewer?: WorkerReport;
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
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

function bounded(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function redact(value: string): string {
  return bounded(
    value
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
      .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED_API_KEY]"),
  );
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
    ? "Review the exact candidate evidence for correctness and contract violations. Do not edit files, run mutating commands, merge, push, close issues, or claim acceptance. Return concise findings only."
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

function workerStats(session: WorkerSession): { toolCalls: number; usage?: WorkerStats } {
  const stats = session.getSessionStats?.();
  if (!stats) return { toolCalls: 0 };
  const usage: WorkerStats = {
    input: stats.input ?? 0,
    output: stats.output ?? 0,
    cacheRead: stats.cacheRead ?? 0,
    cacheWrite: stats.cacheWrite ?? 0,
    total: stats.total ?? 0,
    cost: stats.cost ?? 0,
  };
  return { toolCalls: stats.toolCalls ?? 0, usage };
}

async function runWorker(
  factory: WorkerFactory,
  role: WorkerRole,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  reports: WorkerReport[],
  parentSignal?: AbortSignal,
): Promise<WorkerReport> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let session: WorkerSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let toolCalls = 0;
  let cancelParent: (() => void) | undefined;
  try {
    session = await factory({ cwd, role, signal: controller.signal });
    unsubscribe = session.subscribe((event) => {
      if (typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_execution_end") toolCalls += 1;
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
      model: session.model?.provider && session.model.id ? `${session.model.provider}/${session.model.id}` : undefined,
      durationMs: Date.now() - started,
      toolCalls: Math.max(toolCalls, stats.toolCalls),
      usage: stats.usage,
    };
    reports.push(report);
    return report;
  } catch (error) {
    const timedOut = error instanceof BootstrapError && error.message.includes("timed out");
    const cancelled = controller.signal.aborted && !timedOut;
    if (session?.abort) await session.abort().catch(() => undefined);
    const stats = session ? workerStats(session) : { toolCalls };
    const report: WorkerReport = {
      role,
      disposition: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
      model: session?.model?.provider && session.model.id ? `${session.model.provider}/${session.model.id}` : undefined,
      durationMs: Date.now() - started,
      toolCalls: Math.max(toolCalls, stats.toolCalls),
      usage: stats.usage,
      reason: redact(error instanceof Error ? error.message : String(error)),
    };
    reports.push(report);
    return report;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (parentSignal && cancelParent) parentSignal.removeEventListener("abort", cancelParent);
    session?.dispose();
  }
}

async function runChecks(cwd: string, runner: CommandRunner, timeoutMs: number, signal?: AbortSignal): Promise<CheckReport[]> {
  const checks: CheckReport[] = [];
  for (const command of CHECKS) {
    const result = await runner("sh", ["-c", command], { cwd, timeoutMs, signal });
    const evidence = result.exitCode === 0 ? undefined : redact(bounded((result.stderr || result.stdout).slice(-MAX_FAILURE_EVIDENCE), MAX_FAILURE_EVIDENCE));
    checks.push({
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      passed: result.exitCode === 0,
      failureEvidence: evidence,
    });
    if (result.exitCode !== 0) break;
  }
  return checks;
}

async function candidateEvidence(cwd: string, baselineRevision: string, revision: string, runner: CommandRunner): Promise<string> {
  const [status, committed, unstaged] = await Promise.all([
    git(cwd, ["status", "--short"], runner),
    git(cwd, ["diff", "--no-ext-diff", `${baselineRevision}...${revision}`], runner),
    git(cwd, ["diff", "--no-ext-diff"], runner),
  ]);
  const evidence = [`REVISION: ${revision}`, `BASELINE: ${baselineRevision}`, `STATUS:\n${status || "(clean)"}`, `COMMITTED DIFF:\n${committed || "(none)"}`, `UNSTAGED DIFF:\n${unstaged || "(none)"}`].join("\n\n");
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
  const cwd = resolve(options.cwd ?? process.cwd());
  const repository = await prepareRepository(cwd, runner);
  const worktree = await prepareWorktree(repository, options.issueNumber, runner);
  const issue = dependencies.fetchIssue ? await dependencies.fetchIssue(options.issueNumber, repository.root) : await fetchIssue(options.issueNumber, repository.root, runner);
  const contextFiles = await loadContextFiles(worktree.path, issue);
  const factory = dependencies.createWorker ?? await createDefaultWorkerFactory();
  const workerAttempts: WorkerReport[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "implementation");
  const initialWorker = await runWorker(factory, "implementation", initialPrompt, worktree.path, timeoutMs, workerAttempts, options.signal);
  let checks = await runChecks(worktree.path, runner, timeoutMs, options.signal);
  let repairWorker: WorkerReport | undefined;
  if (!checks.every((check) => check.passed) && options.allowRepair && initialWorker.disposition === "completed") {
    const repairPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "repair", failureEvidence(checks));
    repairWorker = await runWorker(factory, "repair", repairPrompt, worktree.path, timeoutMs, workerAttempts, options.signal);
    checks = await runChecks(worktree.path, runner, timeoutMs, options.signal);
  }
  const revision = await git(worktree.path, ["rev-parse", "HEAD"], runner);
  let reviewer: WorkerReport | undefined;
  if (options.review && initialWorker.disposition === "completed" && checks.every((check) => check.passed)) {
    const candidate = await candidateEvidence(worktree.path, repository.baselineRevision, revision, runner);
    const reviewPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "review", undefined, candidate);
    reviewer = await runWorker(factory, "review", reviewPrompt, worktree.path, timeoutMs, workerAttempts, options.signal);
  }
  const mechanicalPass = checks.length === CHECKS.length && checks.every((check) => check.passed);
  const disposition: Disposition = initialWorker.disposition !== "completed"
    ? "blocked"
    : mechanicalPass
      ? "pass"
      : repairWorker
        ? "repairable-failure"
        : "repairable-failure";
  const reason = disposition === "pass"
    ? undefined
    : initialWorker.reason ?? (failureEvidence(checks) || "worker did not complete deterministic verification");
  return {
    issueNumber: options.issueNumber,
    attempts: workerAttempts.length,
    start: started.toISOString(),
    end: now().toISOString(),
    disposition,
    branch: worktree.branch,
    worktree: relative(repository.root, worktree.path) || ".",
    revision,
    baselineRevision: repository.baselineRevision,
    workerAttempts,
    checks,
    reviewer,
    failureReason: reason,
  };
}

function parseArgs(args: string[]): BootstrapOptions {
  let issueNumber: number | undefined;
  let allowRepair = false;
  let review = false;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--issue") issueNumber = Number(args[++index]);
    else if (arg === "--repair") allowRepair = true;
    else if (arg === "--review") review = true;
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (arg === "--queue") throw new BootstrapError("multi-issue --queue mode is intentionally not implemented");
    else throw new BootstrapError(`unknown option: ${arg}`);
  }
  const parsedIssueNumber = issueNumber;
  if (typeof parsedIssueNumber !== "number" || !Number.isInteger(parsedIssueNumber) || parsedIssueNumber <= 0) throw new BootstrapError("--issue N is required");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new BootstrapError("--timeout-ms must be positive");
  return { issueNumber: parsedIssueNumber, allowRepair, review, timeoutMs };
}

export function exitCodeForDisposition(disposition: Disposition): number {
  return disposition === "pass" ? 0 : disposition === "repairable-failure" ? 1 : 2;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const report = await runBootstrap(parseArgs(args));
    console.log(JSON.stringify(report, null, 2));
    return exitCodeForDisposition(report.disposition);
  } catch (error) {
    console.error(JSON.stringify({ disposition: "blocked", reason: redact(error instanceof Error ? error.message : String(error)) }));
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}

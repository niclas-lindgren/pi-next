import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { sessionModel } from "./auto-telemetry.ts";
import { commitExplicitPaths, readQualityEvidence } from "./commit-safety.ts";
import type { LoopIssueMetrics, LoopState, LoopUsage } from "./loop-state.ts";
import { git, gitRaw, runtimeDir } from "./util.ts";

const execFileAsync = promisify(execFile);
const METRICS_PATH = ".agents/diagnostics/pi-next/metrics.jsonl";
const SNAPSHOT_ROOT = ".agents/skills/pi-performance";
const PENDING_FILE = "pi-next-performance-pending.jsonl";
const MAX_RECORDS = 500;
const MAX_REASON_ITEMS = 8;
export const PERFORMANCE_PUBLICATION_EVERY = 5;

export interface PublishedMaintenanceMetrics {
  triggered: boolean;
  reasons: string[];
  assessmentStatus: string;
  behaviorChanged: boolean;
  usage?: LoopUsage;
  durationMs?: number;
  model?: string;
  modelObservationSource?: "product_session" | "maintenance_session_proxy" | "unknown";
}

export interface PublishedFinalQualityMetrics {
  observed: boolean;
  level?: "quick" | "standard" | "full";
  ok?: boolean;
  commands?: number;
  executedCommands?: number;
  reusedCommands?: number;
  reuseRate?: number;
  executedDurationMs?: number;
}

interface ComplexityMetrics {
  archivedPlanObserved: boolean;
  plannedTasks: number;
  acceptanceCriteria: number;
  loggedCommits: number;
  changedFiles: number;
  sourceFiles: number;
  testFiles: number;
  docsFiles: number;
  migrationFiles: number;
  additions: number;
  deletions: number;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function section(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`^##\\s+${heading}\\s*$`, "im"));
  if (!match || match.index === undefined) return "";
  const after = markdown.slice(match.index + match[0].length);
  const next = after.search(/^##\s+/m);
  return next >= 0 ? after.slice(0, next) : after;
}

function checkboxCount(markdown: string, heading: string): number {
  return section(markdown, heading)
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[[ xX]\]\s+/.test(line)).length;
}

async function archivedPlanForIssue(
  cwd: string,
  issueNumber: number,
): Promise<{ commit: string; markdown: string } | null> {
  const archiveCommit = await git(cwd, [
    "log",
    "-1",
    "--format=%H",
    "--fixed-strings",
    `--grep=chore(agent): archive issue #${issueNumber} plan`,
  ]).catch(() => "");
  if (!archiveCommit) return null;

  const names = await gitRaw(cwd, [
    "show",
    "--pretty=format:",
    "--name-only",
    archiveCommit,
    "--",
    ".ps-next/ARCHIVED",
  ]).catch(() => "");
  const planPath = names
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith(".ps-next/ARCHIVED/PLAN-") && value.endsWith(".md"));
  if (!planPath) return null;

  const markdown = await gitRaw(cwd, ["show", `${archiveCommit}:${planPath}`]).catch(() => "");
  return markdown ? { commit: archiveCommit, markdown } : null;
}

function candidateCommitHashes(markdown: string): string[] {
  const log = section(markdown, "Log");
  const matches = log.match(/\b[0-9a-f]{7,40}\b/gi) || [];
  return [...new Set(matches.map((value) => value.toLowerCase()))];
}

function classifyPath(path: string): "source" | "test" | "docs" | "migration" | "other" {
  if (/^(tests\/|.*\.(test|spec)\.[cm]?[jt]sx?$)/.test(path)) return "test";
  if (/^(docs\/|README(?:\.md)?$|.*\.md$)/i.test(path)) return "docs";
  if (/^(prisma\/migrations\/|.*\/migrations\/)/.test(path)) return "migration";
  if (/^(src\/|app\/|pages\/|components\/|lib\/|scripts\/|messages\/|prisma\/schema\.prisma|\.pi\/extensions\/)/.test(path)) return "source";
  return "other";
}

async function complexityMetrics(cwd: string, issueNumber: number): Promise<ComplexityMetrics> {
  const archived = await archivedPlanForIssue(cwd, issueNumber);
  if (!archived) {
    return {
      archivedPlanObserved: false,
      plannedTasks: 0,
      acceptanceCriteria: 0,
      loggedCommits: 0,
      changedFiles: 0,
      sourceFiles: 0,
      testFiles: 0,
      docsFiles: 0,
      migrationFiles: 0,
      additions: 0,
      deletions: 0,
    };
  }

  const validCommits: string[] = [];
  for (const hash of candidateCommitHashes(archived.markdown)) {
    const full = await git(cwd, ["rev-parse", "--verify", `${hash}^{commit}`]).catch(() => "");
    if (full) validCommits.push(full);
  }

  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const commit of [...new Set(validCommits)]) {
    const numstat = await gitRaw(cwd, [
      "show",
      "--format=",
      "--numstat",
      commit,
      "--",
      ".",
      ":(exclude).ps-next/**",
      ":(exclude).agents/diagnostics/**",
      ":(exclude).pi/runtime/**",
      ":(exclude).pi/logs/**",
    ]).catch(() => "");
    for (const line of numstat.split(/\r?\n/)) {
      const [added, removed, ...rest] = line.split("\t");
      if (!rest.length) continue;
      const path = rest.join("\t").trim();
      if (!path) continue;
      files.add(path);
      additions += /^\d+$/.test(added) ? Number(added) : 0;
      deletions += /^\d+$/.test(removed) ? Number(removed) : 0;
    }
  }

  let sourceFiles = 0;
  let testFiles = 0;
  let docsFiles = 0;
  let migrationFiles = 0;
  for (const path of files) {
    const kind = classifyPath(path);
    if (kind === "source") sourceFiles += 1;
    if (kind === "test") testFiles += 1;
    if (kind === "docs") docsFiles += 1;
    if (kind === "migration") migrationFiles += 1;
  }

  return {
    archivedPlanObserved: true,
    plannedTasks: checkboxCount(archived.markdown, "Tasks"),
    acceptanceCriteria: checkboxCount(archived.markdown, "Acceptance Criteria"),
    loggedCommits: [...new Set(validCommits)].length,
    changedFiles: files.size,
    sourceFiles,
    testFiles,
    docsFiles,
    migrationFiles,
    additions,
    deletions,
  };
}

export function captureFinalQualityMetrics(cwd: string): PublishedFinalQualityMetrics {
  const quality = readQualityEvidence(cwd);
  if (!quality) return { observed: false };
  const commands = quality.commands || [];
  const reusedCommands = commands.filter((command) => Boolean(command.reused)).length;
  const executedCommands = commands.length - reusedCommands;
  const executedDurationMs = commands
    .filter((command) => !command.reused)
    .reduce((sum, command) => sum + finite(command.durationMs), 0);
  return {
    observed: true,
    level: quality.level,
    ok: quality.ok,
    commands: commands.length,
    executedCommands,
    reusedCommands,
    reuseRate: ratio(reusedCommands, commands.length),
    executedDurationMs,
  };
}

function productMetrics(metric: LoopIssueMetrics) {
  const issueFreshTokens = finite(metric.input) + finite(metric.output);
  const prompts = finite(metric.prompts);
  const cacheDenominator = finite(metric.input) + finite(metric.cacheRead);
  return {
    prompts,
    sessions: finite(metric.sessions),
    input: finite(metric.input),
    output: finite(metric.output),
    freshTokens: issueFreshTokens,
    cacheRead: finite(metric.cacheRead),
    cacheWrite: finite(metric.cacheWrite),
    totalTokens: finite(metric.totalTokens),
    costUsd: finite(metric.cost),
    transitionWallMs: finite(metric.modelDurationMs),
    freshTokensPerPrompt: ratio(issueFreshTokens, prompts),
    transitionWallMsPerPrompt: ratio(finite(metric.modelDurationMs), prompts),
    cacheReadShare: ratio(finite(metric.cacheRead), cacheDenominator),
  };
}

function maintenanceMetrics(
  input: PublishedMaintenanceMetrics,
  product: ReturnType<typeof productMetrics>,
) {
  const usage = input.usage;
  const issueFreshTokens = finite(usage?.input) + finite(usage?.output);
  const maintenanceCost = finite(usage?.cost);
  const maintenanceDuration = finite(input.durationMs);
  return {
    triggered: input.triggered,
    reasons: input.reasons.slice(0, MAX_REASON_ITEMS),
    assessmentStatus: input.assessmentStatus,
    behaviorChanged: input.behaviorChanged,
    model: input.model,
    modelObservationSource: input.modelObservationSource || "unknown",
    input: finite(usage?.input),
    output: finite(usage?.output),
    freshTokens: issueFreshTokens,
    cacheRead: finite(usage?.cacheRead),
    cacheWrite: finite(usage?.cacheWrite),
    totalTokens: finite(usage?.totalTokens),
    costUsd: maintenanceCost,
    durationMs: maintenanceDuration,
    freshTokenOverheadShare: ratio(issueFreshTokens, product.freshTokens + issueFreshTokens),
    costOverheadShare: ratio(maintenanceCost, product.costUsd + maintenanceCost),
    wallOverheadShare: ratio(maintenanceDuration, product.transitionWallMs + maintenanceDuration),
  };
}

function normalizedEfficiency(
  product: ReturnType<typeof productMetrics>,
  complexity: ComplexityMetrics,
  quality: PublishedFinalQualityMetrics,
) {
  return {
    freshTokensPerPlannedTask: ratio(product.freshTokens, complexity.plannedTasks),
    freshTokensPerAcceptanceCriterion: ratio(product.freshTokens, complexity.acceptanceCriteria),
    freshTokensPerChangedFile: ratio(product.freshTokens, complexity.changedFiles),
    costUsdPerPlannedTask: ratio(product.costUsd, complexity.plannedTasks),
    transitionWallMsPerPlannedTask: ratio(product.transitionWallMs, complexity.plannedTasks),
    qualityExecutionWallShare: ratio(
      quality.observed ? finite(quality.executedDurationMs) : 0,
      product.transitionWallMs,
    ),
  };
}

async function runtimeIdentity(cwd: string) {
  const piNextTree = await git(cwd, ["rev-parse", "HEAD:.pi/extensions/pi-next"]).catch(() => "");
  return {
    entryPoint: "pi-next-loop",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: cpus().length,
    piNextTree: piNextTree || undefined,
  };
}

function metricsFile(cwd: string): string {
  return join(cwd, METRICS_PATH);
}

function pendingFile(cwd: string): string {
  return join(runtimeDir(cwd), PENDING_FILE);
}

function parseRecords(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

function recordKey(record: Record<string, unknown>): string {
  return `${record.runId}:${record.issueNumber}`;
}

function mergeRecords(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[],
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const record of [...existing, ...incoming]) merged.set(recordKey(record), record);
  return [...merged.values()].slice(-MAX_RECORDS);
}

function writeRecords(path: string, records: Record<string, unknown>[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    records.length ? `${records.map((value) => JSON.stringify(value)).join("\n")}\n` : "",
    "utf8",
  );
}

function stagePendingRecord(cwd: string, record: Record<string, unknown>): void {
  const path = pendingFile(cwd);
  writeRecords(path, mergeRecords(parseRecords(path), [record]));
}

function flushPendingRecords(cwd: string): number {
  const pendingPath = pendingFile(cwd);
  const pending = parseRecords(pendingPath);
  if (!pending.length) return 0;
  const trackedPath = metricsFile(cwd);
  writeRecords(trackedPath, mergeRecords(parseRecords(trackedPath), pending));
  return pending.length;
}

export function shouldPublishPerformanceEvidence(
  completedCount: number,
  maintenanceTriggered: boolean,
): boolean {
  return (
    maintenanceTriggered ||
    (completedCount > 0 && completedCount % PERFORMANCE_PUBLICATION_EVERY === 0)
  );
}

async function generatePortableSnapshot(cwd: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [join(cwd, "scripts", "pi-performance-snapshot.mjs"), cwd],
    { cwd, maxBuffer: 1024 * 1024 },
  );
}

async function pushAndVerify(cwd: string, commit: string): Promise<void> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot publish pi-next performance evidence from detached HEAD");
  }

  const upstream = await git(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]).catch(() => "");

  let remote = "origin";
  let remoteBranch = branch;
  if (upstream.includes("/")) {
    const split = upstream.indexOf("/");
    remote = upstream.slice(0, split);
    remoteBranch = upstream.slice(split + 1);
    await git(cwd, ["push", remote, `HEAD:${remoteBranch}`]);
  } else {
    await git(cwd, ["push", "-u", remote, `HEAD:${remoteBranch}`]);
  }

  await git(cwd, ["fetch", remote, remoteBranch]);
  await git(cwd, ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
}

async function publishPendingEvidence(cwd: string): Promise<string | undefined> {
  const pendingPath = pendingFile(cwd);
  const pendingCount = flushPendingRecords(cwd);
  if (!pendingCount) return undefined;

  await generatePortableSnapshot(cwd);
  const shortCommit = await commitExplicitPaths(
    cwd,
    [METRICS_PATH, SNAPSHOT_ROOT],
    "chore(agent): publish pi-next performance evidence",
  );
  const fullCommit = await git(cwd, ["rev-parse", "HEAD"]);
  await pushAndVerify(cwd, fullCommit);
  if (existsSync(pendingPath)) unlinkSync(pendingPath);
  return shortCommit ? fullCommit : undefined;
}

export async function publishIssuePerformanceMetrics(
  cwd: string,
  state: LoopState,
  issueNumber: number,
  maintenance: PublishedMaintenanceMetrics,
  productQuality: PublishedFinalQualityMetrics = captureFinalQualityMetrics(cwd),
): Promise<string | undefined> {
  const metric = state.issueMetrics.find(
    (item) => item.issueNumber === issueNumber && item.disposition === "completed",
  );
  if (!metric) {
    throw new Error(
      `Cannot publish pi-next metrics for #${issueNumber}: completed telemetry missing`,
    );
  }

  const product = productMetrics(metric);
  const complexity = await complexityMetrics(cwd, issueNumber);
  const maintenanceSummary = maintenanceMetrics(maintenance, product);
  const record: Record<string, unknown> = {
    schemaVersion: 2,
    recordedAt: metric.updatedAt,
    runId: state.runId,
    issueNumber,
    completedAt: metric.updatedAt,
    runtime: await runtimeIdentity(cwd),
    loop: {
      requestedIssues: state.requestedIssues,
      completedCount: state.completedIssues.length,
      deferredCount: state.deferredIssues.length,
      remainingIssues: state.remainingIssues,
      step: state.step,
      maxSteps: state.maxSteps,
    },
    observedModel: maintenance.model,
    product,
    complexity,
    normalizedEfficiency: normalizedEfficiency(product, complexity, productQuality),
    finalQuality: productQuality,
    maintenance: maintenanceSummary,
    allIn: {
      freshTokens: product.freshTokens + maintenanceSummary.freshTokens,
      totalTokens: product.totalTokens + maintenanceSummary.totalTokens,
      costUsd: product.costUsd + maintenanceSummary.costUsd,
      wallMs: product.transitionWallMs + maintenanceSummary.durationMs,
    },
    dataQuality: {
      productTelemetry: true,
      modelObserved: Boolean(maintenance.model),
      productModelExact: maintenance.modelObservationSource === "product_session",
      complexityFromArchivedPlan: complexity.archivedPlanObserved,
      finalQualityObserved: productQuality.observed,
      rawPromptsTracked: false,
      rawTranscriptsTracked: false,
      rawCommandsTracked: false,
      fileNamesTracked: false,
    },
  };

  stagePendingRecord(cwd, record);
  if (
    !shouldPublishPerformanceEvidence(
      state.completedIssues.length,
      maintenance.triggered,
    )
  ) {
    return undefined;
  }
  return publishPendingEvidence(cwd);
}

export function observedSessionModel(ctx: Parameters<typeof sessionModel>[0]): string | undefined {
  return sessionModel(ctx);
}

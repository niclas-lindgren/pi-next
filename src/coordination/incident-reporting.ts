import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { configuredPath, loadPiNextConfig, type PiNextConfig } from "./config.ts";
import type { LifecycleJournalRecord } from "./lifecycle-journal.ts";
import { readLifecycleJournal } from "./lifecycle-journal.ts";
import type { UnifiedLifecycleResult } from "../lifecycle/kernel.ts";
import { piNextRuntimeIdentity } from "../version.ts";
import { bounded, redactSecrets } from "../bootstrap/utils.ts";
import type { BootstrapReport, CheckReport } from "../bootstrap/types.ts";

const execFileAsync = promisify(execFile);

export const INCIDENT_REPORT_VERSION = 1 as const;
export const INCIDENT_FINGERPRINT_MARKER = "<!-- pi-next-incident-fingerprint:";
const MAX_SNIPPET = 2_000;
const MAX_LIST = 80;
const DEFAULT_INCIDENT_REPOSITORY = "niclas-lindgren/pi-next";

export type IncidentCategory = "framework" | "normal-task" | "consumer-config" | "transient" | "diagnostic";
export type IncidentReportability = "upstream" | "local-only" | "not-reportable";

export interface IncidentFailureInput {
  subsystem: string;
  phase: string;
  code: string;
  reason?: string;
  invariant?: string;
  sourceLocation?: string;
  boundary?: "pi-next" | "consumer" | "provider" | "worker" | "unknown";
}

export interface IncidentCheckDiagnostic {
  command: string;
  exitCode: number;
  signal?: string;
  durationMs?: number;
  snippet?: string;
}

export interface IncidentCandidateDiagnostic {
  head?: string;
  baseline?: string;
  mergeBase?: string;
  originMain?: string;
  aheadOfMergeBase?: number;
  aheadOfOriginMain?: number;
  behindOriginMain?: number;
  divergedFromOriginMain?: boolean;
  dirty?: boolean;
  committedFiles?: string[];
  stagedFiles?: string[];
  unstagedFiles?: string[];
  untrackedFiles?: string[];
}

export interface IncidentLifecycleDiagnostic {
  entry?: string;
  runId?: string;
  issueNumber?: number;
  phase?: string;
  disposition?: string;
  implementation?: string;
  verification?: string;
  finalization?: string;
  repair?: string;
  workerAttempts?: {
    role: string;
    disposition: string;
    model?: string;
    durationMs?: number;
    toolCalls?: number;
    stopReason?: string;
    terminalResultKind?: string;
    terminalResultObserved?: boolean;
    assistantOutputObserved?: boolean;
  }[];
}

export interface IncidentIdentityMismatchDiagnostic {
  activeIssue?: number;
  activeRunId?: string;
  visibleIssue?: number;
  visibleRunId?: string;
  footerIssue?: number;
  footerRunId?: string;
}

export interface IncidentDiagnosticBundle {
  version: typeof INCIDENT_REPORT_VERSION;
  createdAt: string;
  fingerprint: string;
  classification: {
    category: IncidentCategory;
    reportability: IncidentReportability;
    reason: string;
  };
  runtime: {
    piNextVersion: string;
    piNextRevision: string;
    node: string;
    platform: string;
    tools?: Record<string, string>;
  };
  repository?: {
    root?: string;
    identity?: string;
  };
  command?: {
    mode?: string;
    argv?: string[];
  };
  source?: {
    issueNumber?: number;
  };
  failure: IncidentFailureInput;
  lifecycle?: IncidentLifecycleDiagnostic;
  candidate?: IncidentCandidateDiagnostic;
  checks?: IncidentCheckDiagnostic[];
  lock?: Record<string, unknown>;
  authority?: Record<string, unknown>;
  checkpoints?: { sequence: number; at: string; event: string; phase?: string; reasonCode?: string }[];
  identityMismatch?: IncidentIdentityMismatchDiagnostic;
  reproductionHints?: string[];
}

export interface IncidentBundleInput {
  cwd?: string;
  command?: IncidentDiagnosticBundle["command"];
  source?: IncidentDiagnosticBundle["source"];
  failure: IncidentFailureInput;
  lifecycle?: IncidentLifecycleDiagnostic;
  candidate?: IncidentCandidateDiagnostic;
  checks?: IncidentCheckDiagnostic[];
  lock?: Record<string, unknown>;
  authority?: Record<string, unknown>;
  checkpoints?: LifecycleJournalRecord[];
  identityMismatch?: IncidentIdentityMismatchDiagnostic;
  reproductionHints?: string[];
  createdAt?: string;
}

export interface IncidentReportTargetIssue {
  number: number;
  state: "OPEN" | "CLOSED" | "open" | "closed";
  url?: string;
  title?: string;
  body?: string;
}

export interface IncidentGithubAuthority {
  searchFingerprint(repository: string, fingerprint: string): Promise<IncidentReportTargetIssue[]>;
  appendOccurrence(repository: string, issueNumber: number, body: string): Promise<{ url?: string }>;
  createIssue(repository: string, title: string, body: string, labels?: string[]): Promise<{ number?: number; url?: string }>;
}

export type IncidentPublishResult =
  | { status: "commented"; fingerprint: string; issueNumber: number; url?: string }
  | { status: "created"; fingerprint: string; issueNumber?: number; url?: string; linkedIssueNumber?: number }
  | { status: "ambiguous"; fingerprint: string; reason: string; matches: IncidentReportTargetIssue[] }
  | { status: "local-only"; fingerprint: string; reason: string };

function safeString(value: unknown, max = MAX_SNIPPET): string | undefined {
  if (value === undefined || value === null) return undefined;
  return bounded(redactSecrets(String(value)), max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function safeList(values: readonly unknown[] | undefined, max = MAX_LIST): string[] | undefined {
  const list = (values || []).map((value) => safeString(value, 300)?.trim()).filter((value): value is string => Boolean(value));
  return list.length ? [...new Set(list)].slice(0, max) : undefined;
}

const FORBIDDEN_KEY = /prompt|transcript|reasoning|secret|password|token|authorization|api[_-]?key|environment|env|issue[_-]?body|raw[_-]?(?:output|content)|full[_-]?log/i;

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return safeString(value, MAX_SNIPPET);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map((entry) => sanitizeUnknown(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      out[key] = sanitizeUnknown(entry, depth + 1);
    }
    return out;
  }
  return undefined;
}

function slug(value: string, fallback = "unknown"): string {
  const stripped = value
    .replace(/[0-9a-f]{7,40}/gi, "sha")
    .replace(/#?\b\d{2,}\b/g, "n")
    .replace(/run-[a-z0-9._-]+/gi, "run")
    .replace(/issue-\d+/gi, "issue-n")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return stripped || fallback;
}

const FRAMEWORK_CODES = new Set([
  "UNKNOWN_CHANGES",
  "IMPOSSIBLE_TRANSITION",
  "LIFECYCLE_INVARIANT",
  "FINALIZER_INVARIANT",
  "CHECKPOINT_REPLAY_MISMATCH",
  "CANDIDATE_IDENTITY_MISMATCH",
  "CONTROLLER_IDENTITY_MISMATCH",
  "CLI_CAPABILITY_MISMATCH",
  "BOOTSTRAP_FINALIZER_INVARIANT",
]);

const TRANSIENT_PATTERN = /network|timeout|timed?_?out|rate[_ -]?limit|econnreset|enotfound|temporar|provider[_ -]?(?:unavailable|outage)|github[_ -]?outage|resource[_ -]?exhaust/i;
const CONSUMER_PATTERN = /invalid_pi_next_config|consumer|repository[_ -]?policy|workflow_state_provider|config/i;
const NORMAL_WORKER_PATTERN = /test|check|worker|implementation|review|acceptance|verification/i;

export function classifyIncident(input: IncidentFailureInput & { disposition?: string }): IncidentDiagnosticBundle["classification"] {
  const code = input.code || "UNKNOWN";
  const text = `${input.subsystem} ${input.phase} ${code} ${input.reason || ""}`;
  if (input.boundary === "consumer" || CONSUMER_PATTERN.test(code) || /^consumer/.test(input.subsystem)) {
    return { category: "consumer-config", reportability: "local-only", reason: "failure is at the configured consumer/repository boundary" };
  }
  if (input.boundary === "provider" || TRANSIENT_PATTERN.test(text)) {
    return { category: "transient", reportability: "not-reportable", reason: "transient provider/environment condition is not filed automatically" };
  }
  if (input.boundary === "worker" || (/^(worker|implementation|repair|review|verification|check)$/.test(input.phase) && NORMAL_WORKER_PATTERN.test(text) && input.boundary !== "pi-next")) {
    return { category: "normal-task", reportability: "not-reportable", reason: "ordinary implementation/verification outcome is not an upstream framework incident" };
  }
  if (
    input.boundary === "pi-next"
    || FRAMEWORK_CODES.has(code)
    || /^(lifecycle|controller|auto-controller|bootstrap-finalizer|finalizer|selector|journal|lifecycle-lock)/.test(input.subsystem)
    || /identity mismatch|impossible|invariant|representation drift|replay mismatch|capability/i.test(text)
  ) {
    return { category: "framework", reportability: "upstream", reason: "typed pi-next framework/controller invariant failure" };
  }
  return { category: "diagnostic", reportability: "local-only", reason: "ambiguous failure retained locally for operator review" };
}

export function computeIncidentFingerprint(failure: IncidentFailureInput): string {
  const subsystem = slug(failure.subsystem, "subsystem");
  const code = slug(failure.code, "code").toUpperCase().replaceAll("-", "_");
  const root = failure.invariant || failure.sourceLocation || failure.reason || "unknown-root-cause";
  return `${subsystem}/${code}/${slug(root, "root-cause")}/v1`;
}

function toolVersion(command: string, args: string[]): string | undefined {
  try {
    const value = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim();
    return safeString(value.split(/\r?\n/)[0], 160);
  } catch {
    return undefined;
  }
}

function repositoryIdentity(cwd: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim();
    return safeString(url.replace(/:\/\/[^/@]+@/, "://[REDACTED]@"), 300);
  } catch {
    return undefined;
  }
}

function normalizeChecks(checks: readonly IncidentCheckDiagnostic[] | undefined): IncidentCheckDiagnostic[] | undefined {
  const result = (checks || []).slice(0, 20).map((check) => ({
    command: safeString(check.command, 200) || "unknown",
    exitCode: Number.isFinite(check.exitCode) ? check.exitCode : -1,
    ...(check.signal ? { signal: safeString(check.signal, 60) } : {}),
    ...(Number.isFinite(check.durationMs) ? { durationMs: check.durationMs } : {}),
    ...(check.snippet ? { snippet: safeString(check.snippet, MAX_SNIPPET) } : {}),
  }));
  return result.length ? result : undefined;
}

function normalizeCandidate(candidate: IncidentCandidateDiagnostic | undefined): IncidentCandidateDiagnostic | undefined {
  if (!candidate) return undefined;
  return {
    ...(candidate.head ? { head: safeString(candidate.head, 80) } : {}),
    ...(candidate.baseline ? { baseline: safeString(candidate.baseline, 80) } : {}),
    ...(candidate.mergeBase ? { mergeBase: safeString(candidate.mergeBase, 80) } : {}),
    ...(candidate.originMain ? { originMain: safeString(candidate.originMain, 80) } : {}),
    ...(Number.isFinite(candidate.aheadOfMergeBase) ? { aheadOfMergeBase: candidate.aheadOfMergeBase } : {}),
    ...(Number.isFinite(candidate.aheadOfOriginMain) ? { aheadOfOriginMain: candidate.aheadOfOriginMain } : {}),
    ...(Number.isFinite(candidate.behindOriginMain) ? { behindOriginMain: candidate.behindOriginMain } : {}),
    ...(candidate.divergedFromOriginMain !== undefined ? { divergedFromOriginMain: candidate.divergedFromOriginMain } : {}),
    ...(candidate.dirty !== undefined ? { dirty: candidate.dirty } : {}),
    ...(safeList(candidate.committedFiles) ? { committedFiles: safeList(candidate.committedFiles) } : {}),
    ...(safeList(candidate.stagedFiles) ? { stagedFiles: safeList(candidate.stagedFiles) } : {}),
    ...(safeList(candidate.unstagedFiles) ? { unstagedFiles: safeList(candidate.unstagedFiles) } : {}),
    ...(safeList(candidate.untrackedFiles) ? { untrackedFiles: safeList(candidate.untrackedFiles) } : {}),
  };
}

function normalizeJournal(records: readonly LifecycleJournalRecord[] | undefined): IncidentDiagnosticBundle["checkpoints"] | undefined {
  const mapped = (records || []).slice(-20).map((record) => ({
    sequence: record.sequence,
    at: record.at,
    event: record.event,
    ...(record.payload.phase ? { phase: record.payload.phase } : {}),
    ...(record.payload.reasonCode ? { reasonCode: record.payload.reasonCode } : {}),
  }));
  return mapped.length ? mapped : undefined;
}

export function createIncidentBundle(input: IncidentBundleInput): IncidentDiagnosticBundle {
  const cwd = input.cwd ? resolve(input.cwd) : undefined;
  const runtime = piNextRuntimeIdentity();
  const failure = sanitizeUnknown(input.failure) as IncidentFailureInput;
  const classification = classifyIncident(failure);
  const fingerprint = computeIncidentFingerprint(failure);
  const bundle: IncidentDiagnosticBundle = {
    version: INCIDENT_REPORT_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    fingerprint,
    classification,
    runtime: {
      piNextVersion: runtime.version,
      piNextRevision: runtime.revision,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      tools: {
        ...(toolVersion("git", ["--version"]) ? { git: toolVersion("git", ["--version"])! } : {}),
        ...(toolVersion("gh", ["--version"]) ? { gh: toolVersion("gh", ["--version"])! } : {}),
        ...(toolVersion("npm", ["--version"]) ? { npm: toolVersion("npm", ["--version"])! } : {}),
      },
    },
    ...(cwd ? { repository: { root: cwd, ...(repositoryIdentity(cwd) ? { identity: repositoryIdentity(cwd) } : {}) } } : {}),
    ...(input.command ? { command: sanitizeUnknown(input.command) as IncidentDiagnosticBundle["command"] } : {}),
    ...(input.source ? { source: sanitizeUnknown(input.source) as IncidentDiagnosticBundle["source"] } : {}),
    failure,
    ...(input.lifecycle ? { lifecycle: sanitizeUnknown(input.lifecycle) as IncidentLifecycleDiagnostic } : {}),
    ...(normalizeCandidate(input.candidate) ? { candidate: normalizeCandidate(input.candidate) } : {}),
    ...(normalizeChecks(input.checks) ? { checks: normalizeChecks(input.checks) } : {}),
    ...(input.lock ? { lock: sanitizeUnknown(input.lock) as Record<string, unknown> } : {}),
    ...(input.authority ? { authority: sanitizeUnknown(input.authority) as Record<string, unknown> } : {}),
    ...(normalizeJournal(input.checkpoints) ? { checkpoints: normalizeJournal(input.checkpoints) } : {}),
    ...(input.identityMismatch ? { identityMismatch: sanitizeUnknown(input.identityMismatch) as IncidentIdentityMismatchDiagnostic } : {}),
    ...(safeList(input.reproductionHints, 12) ? { reproductionHints: safeList(input.reproductionHints, 12) } : {}),
  };
  return bundle;
}

export function incidentDiagnosticsDir(cwd: string, config: Pick<PiNextConfig, "workflow"> = loadPiNextConfig(cwd)): string {
  return configuredPath(cwd, join(config.workflow.diagnosticsPath, "incidents"));
}

function incidentFileName(bundle: Pick<IncidentDiagnosticBundle, "createdAt" | "fingerprint">): string {
  const stamp = bundle.createdAt.replace(/[^0-9TZ.-]/g, "-").replaceAll(":", "");
  const digest = createHash("sha256").update(bundle.fingerprint).digest("hex").slice(0, 12);
  return `${stamp}-${digest}.json`;
}

function incidentIssueKey(bundle: Pick<IncidentDiagnosticBundle, "source" | "lifecycle">): number | undefined {
  return bundle.source?.issueNumber ?? bundle.lifecycle?.issueNumber;
}

function existingEquivalentIncidentFile(dir: string, bundle: IncidentDiagnosticBundle): string | undefined {
  if (!existsSync(dir)) return undefined;
  const issue = incidentIssueKey(bundle);
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json") && entry !== "last.json").sort()) {
    try {
      const existing = readIncidentBundle(join(dir, file));
      if (existing.fingerprint === bundle.fingerprint && incidentIssueKey(existing) === issue) return join(dir, file);
    } catch {
      // Ignore corrupt optional diagnostics; a fresh sanitized bundle can replace them.
    }
  }
  return undefined;
}

export function persistIncidentBundle(cwd: string, bundle: IncidentDiagnosticBundle, config: Pick<PiNextConfig, "workflow"> = loadPiNextConfig(cwd)): { path: string; lastPath: string } {
  const dir = incidentDiagnosticsDir(cwd, config);
  mkdirSync(dir, { recursive: true });
  const lastPath = join(dir, "last.json");
  const existing = existingEquivalentIncidentFile(dir, bundle);
  if (existing) {
    if (!existsSync(lastPath)) writeFileSync(lastPath, readFileSync(existing, "utf8"), "utf8");
    return { path: existing, lastPath };
  }
  const path = join(dir, incidentFileName(bundle));
  const data = `${JSON.stringify(bundle, null, 2)}\n`;
  writeFileSync(path, data, "utf8");
  writeFileSync(lastPath, data, "utf8");
  return { path, lastPath };
}

export function readIncidentBundle(path: string): IncidentDiagnosticBundle {
  return JSON.parse(readFileSync(path, "utf8")) as IncidentDiagnosticBundle;
}

export function readLastIncidentBundle(cwd: string, issueNumber?: number): IncidentDiagnosticBundle | undefined {
  const config = loadPiNextConfig(cwd);
  const dir = incidentDiagnosticsDir(cwd, config);
  if (!existsSync(dir)) return undefined;
  if (issueNumber === undefined) {
    const last = join(dir, "last.json");
    return existsSync(last) ? readIncidentBundle(last) : undefined;
  }
  const files = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "last.json").sort().reverse();
  for (const file of files) {
    const bundle = readIncidentBundle(join(dir, file));
    if (bundle.source?.issueNumber === issueNumber || bundle.lifecycle?.issueNumber === issueNumber) return bundle;
  }
  return undefined;
}

function checkFromBootstrap(check: CheckReport): IncidentCheckDiagnostic {
  return {
    command: check.command,
    exitCode: check.exitCode,
    ...(check.signal ? { signal: check.signal } : {}),
    durationMs: check.durationMs,
    ...(check.failureEvidence ? { snippet: check.failureEvidence } : {}),
  };
}

export function incidentBundleFromLifecycleResult(cwd: string, result: UnifiedLifecycleResult, journals?: LifecycleJournalRecord[]): IncidentDiagnosticBundle | undefined {
  const report: BootstrapReport = result.implementationReport;
  const failure = result.finalizationFailure
    ? {
        subsystem: "bootstrap-finalizer",
        phase: "finalization",
        code: result.finalizationFailure.code,
        reason: result.finalizationFailure.reason,
        invariant: result.finalizationFailure.code === "UNKNOWN_CHANGES" ? "candidate path identity drift or unexpected worktree changes" : undefined,
        boundary: "pi-next" as const,
      }
    : report.failureReason
      ? {
          subsystem: report.implementationOutcome === "failed" ? "worker" : "verification",
          phase: report.mechanicalPass ? "worker" : "verification",
          code: report.implementationOutcome === "failed" ? "WORKER_FAILED" : "CHECK_FAILED",
          reason: report.failureReason,
          boundary: "worker" as const,
        }
      : undefined;
  if (!failure) return undefined;
  return createIncidentBundle({
    cwd,
    command: { mode: result.entry },
    source: { issueNumber: result.issueNumber },
    failure,
    lifecycle: {
      entry: result.entry,
      runId: result.runId,
      issueNumber: result.issueNumber,
      phase: result.projection.phase,
      disposition: result.disposition,
      implementation: result.implementation,
      verification: result.verification,
      finalization: result.finalization,
      repair: result.repair,
      workerAttempts: report.workerAttempts.map((attempt) => ({
        role: attempt.role,
        disposition: attempt.disposition,
        ...(attempt.model ? { model: attempt.model } : {}),
        durationMs: attempt.durationMs,
        toolCalls: attempt.toolCalls,
        ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
        ...(attempt.terminalResultKind ? { terminalResultKind: attempt.terminalResultKind } : {}),
        terminalResultObserved: attempt.terminalResultObserved,
        ...(attempt.assistantOutputObserved !== undefined ? { assistantOutputObserved: attempt.assistantOutputObserved } : {}),
      })),
    },
    candidate: {
      head: report.candidate.headRevision || report.revision,
      baseline: report.candidate.baselineRevision || report.baselineRevision,
      mergeBase: report.candidate.mergeBaseRevision,
      originMain: report.candidate.originMainRevision,
      aheadOfMergeBase: report.candidate.commitsAheadOfMergeBase,
      aheadOfOriginMain: report.candidate.commitsAheadOfOriginMain,
      behindOriginMain: report.candidate.commitsBehindOriginMain,
      divergedFromOriginMain: report.candidate.divergedFromOriginMain,
      dirty: report.candidate.dirty,
      committedFiles: report.candidate.committedFiles,
      stagedFiles: report.candidate.stagedFiles,
      unstagedFiles: report.candidate.unstagedFiles,
      untrackedFiles: report.candidate.untrackedFiles,
    },
    checks: report.checks.map(checkFromBootstrap),
    checkpoints: journals,
    reproductionHints: [
      `Inspect preserved worktree ${report.worktree}`,
      `Re-run deterministic checks: ${report.checks.map((check) => check.command).join(" && ") || "none recorded"}`,
    ],
  });
}

export function createControllerIdentityMismatchIncident(input: {
  cwd?: string;
  activeIssue?: number;
  activeRunId?: string;
  visibleIssue?: number;
  visibleRunId?: string;
  footerIssue?: number;
  footerRunId?: string;
  phase?: string;
  reason?: string;
}): IncidentDiagnosticBundle {
  return createIncidentBundle({
    cwd: input.cwd,
    ...(input.activeIssue !== undefined ? { source: { issueNumber: input.activeIssue } } : {}),
    failure: {
      subsystem: "auto-controller",
      phase: input.phase || "controller",
      code: "CONTROLLER_IDENTITY_MISMATCH",
      reason: input.reason || "active controller issue/run identity disagrees with visible status/footer identity",
      invariant: "single canonical lifecycle projection identity",
      boundary: "pi-next",
    },
    identityMismatch: {
      activeIssue: input.activeIssue,
      activeRunId: input.activeRunId,
      visibleIssue: input.visibleIssue,
      visibleRunId: input.visibleRunId,
      footerIssue: input.footerIssue,
      footerRunId: input.footerRunId,
    },
  });
}

export function incidentMarker(fingerprint: string): string {
  return `${INCIDENT_FINGERPRINT_MARKER} ${fingerprint} -->`;
}

export function renderIncidentIssue(bundle: IncidentDiagnosticBundle, linkedClosed?: IncidentReportTargetIssue): { title: string; body: string } {
  const title = `[pi-next incident] ${bundle.failure.subsystem} ${bundle.failure.code}`.slice(0, 120);
  const lines = [
    incidentMarker(bundle.fingerprint),
    "",
    `Fingerprint: \`${bundle.fingerprint}\``,
    `Classification: ${bundle.classification.category}/${bundle.classification.reportability}`,
    linkedClosed ? `Regression follow-up for closed incident: ${linkedClosed.url || `#${linkedClosed.number}`}` : undefined,
    "",
    "## Failure",
    `- subsystem: ${bundle.failure.subsystem}`,
    `- phase: ${bundle.failure.phase}`,
    `- code: ${bundle.failure.code}`,
    bundle.failure.invariant ? `- invariant: ${bundle.failure.invariant}` : undefined,
    bundle.failure.reason ? `- reason: ${bundle.failure.reason}` : undefined,
    "",
    "## Runtime",
    `- pi-next: ${bundle.runtime.piNextVersion} (${bundle.runtime.piNextRevision})`,
    `- node: ${bundle.runtime.node}`,
    bundle.repository?.identity ? `- repository: ${bundle.repository.identity}` : undefined,
    bundle.lifecycle?.issueNumber ? `- source issue: #${bundle.lifecycle.issueNumber}` : undefined,
    bundle.lifecycle?.runId ? `- run: ${bundle.lifecycle.runId}` : undefined,
    "",
    "## Lifecycle",
    bundle.lifecycle ? `- disposition: ${bundle.lifecycle.disposition || "unknown"}; implementation=${bundle.lifecycle.implementation || "?"}; verification=${bundle.lifecycle.verification || "?"}; finalization=${bundle.lifecycle.finalization || "?"}` : "- not available",
    bundle.lifecycle?.workerAttempts?.length ? `- worker attempts: ${bundle.lifecycle.workerAttempts.map((attempt) => `${attempt.role}:${attempt.disposition}`).join(", ")}` : undefined,
    "",
    "## Candidate/checks",
    bundle.candidate ? `- head=${bundle.candidate.head || "?"} baseline=${bundle.candidate.baseline || "?"} origin/main=${bundle.candidate.originMain || "?"} ahead=${bundle.candidate.aheadOfOriginMain ?? "?"} behind=${bundle.candidate.behindOriginMain ?? "?"} dirty=${bundle.candidate.dirty ?? "?"}` : "- candidate metadata unavailable",
    ...(bundle.checks || []).slice(0, 8).map((check) => `- ${check.command}: exit=${check.exitCode}${check.snippet ? ` — ${check.snippet.replace(/\s+/g, " ").slice(0, 300)}` : ""}`),
    "",
    "## Recent checkpoints",
    ...(bundle.checkpoints || []).slice(-10).map((event) => `- ${event.sequence}. ${event.event}${event.phase ? ` (${event.phase})` : ""}`),
    "",
    "Generated deterministically by pi-next incident reporting. Prompts, transcripts, secrets, and unbounded logs are intentionally excluded.",
  ].filter((line): line is string => Boolean(line));
  return { title, body: bounded(lines.join("\n"), 12_000) };
}

export function renderIncidentOccurrence(bundle: IncidentDiagnosticBundle): string {
  const lines = [
    incidentMarker(bundle.fingerprint),
    `New occurrence at ${bundle.createdAt}`,
    "",
    `- classification: ${bundle.classification.category}/${bundle.classification.reportability}`,
    `- source issue: ${bundle.lifecycle?.issueNumber ? `#${bundle.lifecycle.issueNumber}` : bundle.source?.issueNumber ? `#${bundle.source.issueNumber}` : "unknown"}`,
    `- run: ${bundle.lifecycle?.runId || "unknown"}`,
    `- phase/code: ${bundle.failure.phase}/${bundle.failure.code}`,
    bundle.failure.reason ? `- reason: ${bundle.failure.reason}` : undefined,
    bundle.candidate?.head ? `- candidate: ${bundle.candidate.head}` : undefined,
    bundle.checks?.length ? `- checks: ${bundle.checks.map((check) => `${check.command}=${check.exitCode}`).join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return bounded(lines.join("\n"), 6_000);
}

export async function publishIncidentToGithub(
  bundle: IncidentDiagnosticBundle,
  options: { repository?: string; authority: IncidentGithubAuthority },
): Promise<IncidentPublishResult> {
  if (bundle.classification.reportability !== "upstream") {
    return { status: "local-only", fingerprint: bundle.fingerprint, reason: bundle.classification.reason };
  }
  const repository = options.repository || DEFAULT_INCIDENT_REPOSITORY;
  const matches = await options.authority.searchFingerprint(repository, bundle.fingerprint);
  const open = matches.filter((issue) => String(issue.state).toUpperCase() === "OPEN");
  const closed = matches.filter((issue) => String(issue.state).toUpperCase() === "CLOSED");
  if (open.length === 1) {
    const result = await options.authority.appendOccurrence(repository, open[0]!.number, renderIncidentOccurrence(bundle));
    return { status: "commented", fingerprint: bundle.fingerprint, issueNumber: open[0]!.number, url: result.url || open[0]!.url };
  }
  if (open.length > 1 || (open.length === 0 && closed.length > 1)) {
    return { status: "ambiguous", fingerprint: bundle.fingerprint, reason: "multiple matching incident issues; refusing to mutate", matches };
  }
  const linked = closed[0];
  const rendered = renderIncidentIssue(bundle, linked);
  const result = await options.authority.createIssue(repository, rendered.title, rendered.body, ["incident", "pi-next-framework"]);
  return { status: "created", fingerprint: bundle.fingerprint, issueNumber: result.number, url: result.url, ...(linked ? { linkedIssueNumber: linked.number } : {}) };
}

export class GitHubCliIncidentAuthority implements IncidentGithubAuthority {
  constructor(private readonly cwd = process.cwd()) {}

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, { cwd: this.cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
    return stdout;
  }

  async searchFingerprint(repository: string, fingerprint: string): Promise<IncidentReportTargetIssue[]> {
    const stdout = await this.gh(["issue", "list", "--repo", repository, "--state", "all", "--search", `${fingerprint} in:body`, "--limit", "20", "--json", "number,state,url,title"]);
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("gh issue list returned non-array incident search result");
    return parsed.map((item) => {
      const record = item as Record<string, unknown>;
      return { number: Number(record.number), state: String(record.state) as IncidentReportTargetIssue["state"], url: String(record.url || "") || undefined, title: String(record.title || "") || undefined };
    }).filter((item) => Number.isSafeInteger(item.number) && item.number > 0);
  }

  async appendOccurrence(repository: string, issueNumber: number, body: string): Promise<{ url?: string }> {
    await this.gh(["issue", "comment", String(issueNumber), "--repo", repository, "--body", body]);
    return { url: `https://github.com/${repository}/issues/${issueNumber}` };
  }

  async createIssue(repository: string, title: string, body: string, labels: string[] = []): Promise<{ number?: number; url?: string }> {
    const stdout = await this.gh(["issue", "create", "--repo", repository, "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])]);
    const url = stdout.trim().split(/\s+/).find((value) => /^https?:\/\//.test(value));
    const number = url ? Number.parseInt(basename(url), 10) : undefined;
    return { ...(Number.isSafeInteger(number) ? { number } : {}), ...(url ? { url } : {}) };
  }
}

export async function reportIncidentBundle(
  cwd: string,
  bundle: IncidentDiagnosticBundle,
  options: { github?: boolean; authority?: IncidentGithubAuthority; config?: PiNextConfig } = {},
): Promise<{ local: { path: string; lastPath: string }; github?: IncidentPublishResult | { status: "failed"; reason: string } }> {
  const config = options.config || loadPiNextConfig(cwd);
  const local = persistIncidentBundle(cwd, bundle, config);
  if (!options.github) return { local };
  try {
    const github = await publishIncidentToGithub(bundle, {
      repository: config.incidentReporting.repository,
      authority: options.authority || new GitHubCliIncidentAuthority(cwd),
    });
    return { local, github };
  } catch (error) {
    return { local, github: { status: "failed", reason: safeString(error instanceof Error ? error.message : String(error), 500) || "github reporting failed" } };
  }
}

export function readRunJournalIfAvailable(cwd: string, runId?: string): LifecycleJournalRecord[] | undefined {
  if (!runId) return undefined;
  const root = join(cwd, ".pi", "runtime", "journal");
  if (!existsSync(root)) return undefined;
  const safeRun = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "run";
  const files = readdirSync(root).filter((file) => file.startsWith(safeRun) && file.endsWith(".jsonl"));
  for (const file of files) {
    try { return readLifecycleJournal(join(root, file)); } catch { /* ignore corrupt optional diagnostics */ }
  }
  return undefined;
}

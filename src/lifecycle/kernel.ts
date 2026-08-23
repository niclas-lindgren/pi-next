import { resolve } from "node:path";

import {
  type BootstrapDependencies,
  type BootstrapFinalizerReport,
  type BootstrapLifecycleOptions,
  type BootstrapOptions,
  type BootstrapProgressEvent,
  type BootstrapReport,
  type CommandRunner,
  type Disposition,
} from "../bootstrap/types.js";
import { BootstrapError } from "../bootstrap/errors.js";
import { runCommand } from "../bootstrap/command-runner.js";
import { redact } from "../bootstrap/utils.js";
import { acquireBootstrapLifecycleLock } from "../bootstrap/lifecycle-lock.js";
import { hasExactVerifiedFinalizationCandidate } from "../bootstrap/finalization-proof.js";
import { runBootstrapFinalize } from "../../scripts/bootstrap-finalize.ts";

export type LifecycleEntryPoint = "bootstrap" | "explicit" | "auto" | "monitor";

export interface LifecycleWorkItem {
  issueNumber: number;
}

export interface LifecycleRunIdentity {
  runId: string;
  entry: LifecycleEntryPoint;
  issueNumber: number;
}

export type LifecyclePhase = "preflight" | "claim" | "worker" | "verification" | "repair" | "finalization" | "cleanup" | "terminal";

export interface LifecycleStateProjection {
  activeIssue?: number;
  runId: string;
  phase: LifecyclePhase;
  workerLive: boolean;
  terminalDisposition?: UnifiedLifecycleResult["disposition"];
}

export interface LifecycleReporter {
  (event: BootstrapProgressEvent & { runId?: string; entry?: LifecycleEntryPoint; projection?: LifecycleStateProjection }): void;
}

export interface SingleIssueLifecycleOptions extends Omit<BootstrapLifecycleOptions, "issueNumber"> {
  workItem: LifecycleWorkItem;
  entry?: LifecycleEntryPoint;
  runId?: string;
  reporter?: LifecycleReporter;
}

export interface SingleIssueLifecycleDependencies extends BootstrapDependencies {
  runCommand?: CommandRunner;
}

export interface UnifiedLifecycleResult {
  issueNumber: number;
  runId: string;
  entry: LifecycleEntryPoint;
  disposition: Disposition | "finalization-blocked";
  implementation: "PASS" | "FAIL" | "BLOCKED";
  verification: "PASS" | "FAIL";
  finalization: "PASS" | "BLOCKED" | "SKIPPED";
  candidatePreserved?: boolean;
  repair?: "NOT_NEEDED" | "DISABLED" | "INELIGIBLE" | "COMPLETED" | "EXHAUSTED" | "FAILED";
  implementationReport: BootstrapReport;
  finalizationReport?: BootstrapFinalizerReport;
  finalizationFailure?: { code: string; reason: string };
  projection: LifecycleStateProjection;
}

export type IssueLifecycleExecutor = (
  options: BootstrapOptions,
  dependencies?: BootstrapDependencies,
) => Promise<BootstrapReport>;

function implementationPhase(report: BootstrapReport): UnifiedLifecycleResult["implementation"] {
  if (report.implementationOutcome === "failed" || report.implementationOutcome === "retry-exhausted") return report.disposition === "repairable-failure" ? "FAIL" : "BLOCKED";
  return "PASS";
}

function verificationPhase(report: BootstrapReport): UnifiedLifecycleResult["verification"] {
  return report.mechanicalPass ? "PASS" : "FAIL";
}

function repairPhase(report: BootstrapReport): UnifiedLifecycleResult["repair"] {
  if (!report.repairOutcome && report.mechanicalPass) return "NOT_NEEDED";
  switch (report.repairOutcome) {
    case "not-needed": return "NOT_NEEDED";
    case "disabled": return "DISABLED";
    case "completed": return "COMPLETED";
    case "exhausted": return "EXHAUSTED";
    case "failed": return "FAILED";
    case "ineligible":
    default: return "INELIGIBLE";
  }
}

function terminalProjection(result: Omit<UnifiedLifecycleResult, "projection">): LifecycleStateProjection {
  return {
    activeIssue: result.issueNumber,
    runId: result.runId,
    phase: "terminal",
    workerLive: false,
    terminalDisposition: result.disposition,
  };
}

function emit(
  reporter: LifecycleReporter | undefined,
  event: BootstrapProgressEvent,
  identity: LifecycleRunIdentity,
  phase: LifecyclePhase,
  workerLive = false,
): void {
  reporter?.({
    ...event,
    runId: identity.runId,
    entry: identity.entry,
    projection: {
      activeIssue: identity.issueNumber,
      runId: identity.runId,
      phase,
      workerLive,
    },
  });
}

/**
 * Canonical single-issue lifecycle kernel.
 *
 * This is the production-owned primitive used by bootstrap and available to
 * explicit/auto/monitor schedulers.  Entry points may select work differently,
 * but claim, canonical workspace preparation, fresh worker execution,
 * deterministic verification, one bounded repair attempt, guarded finalization
 * and terminal typed result are all delegated here.
 */
export async function runSingleIssueLifecycle(
  options: SingleIssueLifecycleOptions,
  dependencies: SingleIssueLifecycleDependencies = {},
  execute?: IssueLifecycleExecutor,
): Promise<UnifiedLifecycleResult> {
  const entry = options.entry ?? "explicit";
  const issueNumber = options.workItem.issueNumber;
  const runId = options.runId ?? `${entry}-${issueNumber}-${Date.now()}-${process.pid}`;
  const identity: LifecycleRunIdentity = { runId, entry, issueNumber };
  const reporter = options.reporter ?? dependencies.reporter as LifecycleReporter | undefined;
  const runner = dependencies.runCommand ?? runCommand;
  const cwd = resolve(options.cwd ?? process.cwd());

  emit(reporter, { issueNumber, phase: "preflight", state: "start" }, identity, "preflight");
  const rootResult = await runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  if (rootResult.exitCode !== 0) throw new BootstrapError(`could not resolve repository root: ${(rootResult.stderr || rootResult.stdout).trim()}`);
  const commonDirResult = await runner("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (commonDirResult.exitCode !== 0) throw new BootstrapError(`could not resolve repository git directory: ${(commonDirResult.stderr || commonDirResult.stdout).trim()}`);

  const lifecycleLock = await acquireBootstrapLifecycleLock({
    root: rootResult.stdout.trim(),
    gitCommonDir: commonDirResult.stdout.trim(),
    issueNumber,
    operation: entry,
    phase: "preflight",
    heartbeatMs: dependencies.heartbeatMs,
  });

  try {
    const resumeFinalizationOnly = options.finalize && !options.verifyOnly && await hasExactVerifiedFinalizationCandidate({
      root: rootResult.stdout.trim(),
      gitCommonDir: commonDirResult.stdout.trim(),
      issueNumber,
      runCommand: runner,
    });
    await lifecycleLock.update(resumeFinalizationOnly ? "finalization" : "worker");
    emit(reporter, { issueNumber, phase: "worker", state: "start" }, identity, "worker", true);
    const bootstrapOptions: BootstrapOptions = {
      issueNumber,
      cwd: options.cwd,
      allowRepair: options.allowRepair,
      review: options.review,
      timeoutMs: options.timeoutMs,
      verifyOnly: resumeFinalizationOnly ? true : options.verifyOnly,
      implementationRetryBudget: options.implementationRetryBudget,
      signal: options.signal,
    };
    const lifecycleExecutor = execute ?? (await import("../bootstrap/supervisor.js")).runBootstrap;
    const implementationReport = await lifecycleExecutor(bootstrapOptions, { ...dependencies, reporter });
    const base = {
      issueNumber,
      runId,
      entry,
      disposition: implementationReport.disposition,
      implementation: implementationPhase(implementationReport),
      verification: verificationPhase(implementationReport),
      repair: repairPhase(implementationReport),
      candidatePreserved: implementationReport.repairBudgetExhausted || undefined,
      implementationReport,
    } satisfies Omit<UnifiedLifecycleResult, "finalization" | "projection">;

    await lifecycleLock.update("verification");
    if (!options.finalize || options.verifyOnly || !implementationReport.mechanicalPass || (!implementationReport.finalizationReady && !resumeFinalizationOnly)) {
      emit(reporter, { issueNumber, phase: "finalization", state: "skipped", detail: !options.finalize ? "disabled" : options.verifyOnly ? "verify-only" : !implementationReport.mechanicalPass ? "verification-failed" : "not-ready" }, identity, "finalization");
      if (implementationReport.repairBudgetExhausted) emit(reporter, { issueNumber, phase: "terminal", state: "fail", detail: "implementation: PASS; verification: FAIL; repair: EXHAUSTED; candidate preserved" }, identity, "terminal");
      const result = { ...base, finalization: "SKIPPED" } satisfies Omit<UnifiedLifecycleResult, "projection">;
      return { ...result, projection: terminalProjection(result) };
    }

    await lifecycleLock.update("finalization");
    emit(reporter, { issueNumber, phase: "finalization", state: "start" }, identity, "finalization");
    try {
      const runFinalizer = dependencies.runFinalizer ?? ((input) => runBootstrapFinalize(input));
      const finalizationReport = await runFinalizer({
        cwd: options.cwd,
        issueNumber,
        candidatePaths: implementationReport.candidate.changedFiles,
        reporter: (line) => emit(reporter, { issueNumber, phase: "finalization", state: "activity", detail: line }, identity, "finalization"),
        lifecycleLock,
      });
      emit(reporter, { issueNumber, phase: "finalization", state: "pass" }, identity, "finalization");
      emit(reporter, { issueNumber, phase: "terminal", state: "pass", detail: finalizationReport.pendingExternalVerification ? "implementation: PASS; verification: PASS; integration: PASS; external verification: PENDING; cleanup: PASS" : "implementation: PASS; verification: PASS; finalization: PASS" }, identity, "terminal");
      const result = { ...base, disposition: "pass", finalization: "PASS", finalizationReport } satisfies Omit<UnifiedLifecycleResult, "projection">;
      return { ...result, projection: terminalProjection(result) };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "FINALIZATION_FAILED";
      const reason = redact(error instanceof Error ? error.message : String(error));
      emit(reporter, { issueNumber, phase: "finalization", state: "blocked", detail: code }, identity, "finalization");
      emit(reporter, { issueNumber, phase: "terminal", state: "fail", detail: "implementation: PASS; verification: PASS; finalization: BLOCKED; candidate preserved" }, identity, "terminal");
      const result = { ...base, disposition: "finalization-blocked", finalization: "BLOCKED", candidatePreserved: true, finalizationFailure: { code, reason } } satisfies Omit<UnifiedLifecycleResult, "projection">;
      return { ...result, projection: terminalProjection(result) };
    }
  } finally {
    await lifecycleLock.release();
  }
}

import { resolve } from "node:path";
import { BootstrapCliOptions, BootstrapDependencies, BootstrapLifecycleOptions, BootstrapLifecycleReport, BootstrapOptions, BootstrapReport, Disposition, NextIssueSelection } from "./types.js";
import { BootstrapError } from "./errors.js";
import { redact, emitProgress } from "./utils.js";
import { createCliProgressReporter } from "./reporter.js";
import { resolveNextIssue } from "./roadmap.js";
import { runBootstrap } from "./supervisor.js";
import { runCommand } from "./command-runner.js";
import { runBootstrapFinalize } from "../../scripts/bootstrap-finalize.ts";
import { acquireBootstrapLifecycleLock, BootstrapLifecycleLockError } from "./lifecycle-lock.js";
import { hasExactVerifiedFinalizationCandidate } from "./finalization-proof.js";

function parseArgs(args: string[]): BootstrapCliOptions {
  let issueNumber: number | undefined;
  let allowRepair = false;
  let review = false;
  let verifyOnly = false;
  let nextOnly = false;
  let finalize = true;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--issue") issueNumber = Number(args[++index]);
    else if (arg === "--repair") allowRepair = true;
    else if (arg === "--review") review = true;
    else if (arg === "--verify-only" || arg === "--resume") verifyOnly = true;
    else if (arg === "--next-only") nextOnly = true;
    else if (arg === "--no-finalize") finalize = false;
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (arg === "--queue") throw new BootstrapError("multi-issue --queue mode is intentionally not implemented");
    else throw new BootstrapError(`unknown option: ${arg}`);
  }
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber <= 0)) throw new BootstrapError("--issue must be a positive integer");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new BootstrapError("--timeout-ms must be positive");
  return { issueNumber, allowRepair, review, verifyOnly, timeoutMs, nextOnly, finalize };
}

export function exitCodeForDisposition(disposition: Disposition | "finalization-blocked"): number {
  return disposition === "pass" || disposition === "already-satisfied" ? 0 : disposition === "repairable-failure" ? 1 : 2;
}

function implementationPhase(report: BootstrapReport): "PASS" | "FAIL" | "BLOCKED" {
  if (report.implementationOutcome === "failed") return report.disposition === "repairable-failure" ? "FAIL" : "BLOCKED";
  return "PASS";
}

function verificationPhase(report: BootstrapReport): "PASS" | "FAIL" {
  return report.mechanicalPass ? "PASS" : "FAIL";
}

export async function runBootstrapLifecycle(
  options: BootstrapLifecycleOptions,
  dependencies: BootstrapDependencies = {},
  execute: (options: BootstrapOptions, dependencies?: BootstrapDependencies) => Promise<BootstrapReport> = runBootstrap,
): Promise<BootstrapLifecycleReport> {
  const reporter = dependencies.reporter;
  const runner = dependencies.runCommand ?? runCommand;
  const cwd = resolve(options.cwd ?? process.cwd());
  const rootResult = await runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  if (rootResult.exitCode !== 0) throw new BootstrapError(`could not resolve repository root: ${(rootResult.stderr || rootResult.stdout).trim()}`);
  const commonDirResult = await runner("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (commonDirResult.exitCode !== 0) throw new BootstrapError(`could not resolve repository git directory: ${(commonDirResult.stderr || commonDirResult.stdout).trim()}`);
  const lifecycleLock = await acquireBootstrapLifecycleLock({ root: rootResult.stdout.trim(), gitCommonDir: commonDirResult.stdout.trim(), issueNumber: options.issueNumber, operation: "self-host", phase: "preflight", heartbeatMs: dependencies.heartbeatMs });
  try {
    const resumeFinalizationOnly = options.finalize && !options.verifyOnly && await hasExactVerifiedFinalizationCandidate({ root: rootResult.stdout.trim(), gitCommonDir: commonDirResult.stdout.trim(), issueNumber: options.issueNumber, runCommand: runner });
    await lifecycleLock.update(resumeFinalizationOnly ? "finalization" : "worker");
    const implementationReport = await execute(resumeFinalizationOnly ? { ...options, verifyOnly: true } : options, dependencies);
    const base: Omit<BootstrapLifecycleReport, "finalization"> = {
      issueNumber: implementationReport.issueNumber,
      disposition: implementationReport.disposition,
      implementation: implementationPhase(implementationReport),
      verification: verificationPhase(implementationReport),
      implementationReport,
    };
    await lifecycleLock.update("verification");
    if (!options.finalize || options.verifyOnly || !implementationReport.mechanicalPass || (!implementationReport.finalizationReady && !resumeFinalizationOnly)) {
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "finalization", state: "skipped", detail: !options.finalize ? "disabled" : options.verifyOnly ? "verify-only" : !implementationReport.mechanicalPass ? "verification-failed" : "not-ready" });
      return { ...base, finalization: "SKIPPED" };
    }
    await lifecycleLock.update("finalization");
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "finalization", state: "start" });
    try {
      const runFinalizer = dependencies.runFinalizer ?? ((input) => runBootstrapFinalize(input));
      const finalizationReport = await runFinalizer({
        cwd: options.cwd,
        issueNumber: options.issueNumber,
        candidatePaths: implementationReport.candidate.changedFiles,
        reporter: (line) => emitProgress(reporter, { issueNumber: options.issueNumber, phase: "finalization", state: "activity", detail: line }),
        lifecycleLock,
      });
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "finalization", state: "pass" });
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: "pass", detail: finalizationReport.pendingExternalVerification ? "implementation: PASS; verification: PASS; integration: PASS; external verification: PENDING; cleanup: PASS" : "implementation: PASS; verification: PASS; finalization: PASS" });
      return { ...base, disposition: "pass", finalization: "PASS", finalizationReport };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "FINALIZATION_FAILED";
      const reason = redact(error instanceof Error ? error.message : String(error));
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "finalization", state: "blocked", detail: code });
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: "fail", detail: "implementation: PASS; verification: PASS; finalization: BLOCKED; candidate preserved" });
      return { ...base, disposition: "finalization-blocked", finalization: "BLOCKED", candidatePreserved: true, finalizationFailure: { code, reason } };
    }
  } finally {
    await lifecycleLock.release();
  }
}

function printSelection(selection: NextIssueSelection): void {
  for (const skip of selection.skips) console.error(`#${skip.issueNumber} ${skip.reason}`);
  if (selection.selectedIssueNumber !== undefined) console.error(`selected #${selection.selectedIssueNumber}`);
}

export async function runBootstrapCli(
  args = process.argv.slice(2),
  dependencies: BootstrapDependencies = {},
  execute: (options: BootstrapOptions, dependencies?: BootstrapDependencies) => Promise<BootstrapReport> = runBootstrap,
): Promise<number> {
  const reporter = dependencies.reporter ?? createCliProgressReporter();
  let selectedIssueNumber: number | undefined;
  try {
    const cli = parseArgs(args);
    selectedIssueNumber = cli.issueNumber;
    if (selectedIssueNumber === undefined) {
      console.error("bootstrap · discovering next work");
      const selection = await resolveNextIssue(resolve(cli.cwd ?? process.cwd()), dependencies);
      printSelection(selection);
      if (selection.selectedIssueNumber === undefined) {
        console.error(JSON.stringify({ disposition: "blocked", code: "NO_ELIGIBLE_ISSUE", reason: "no dependency-ready roadmap issue exists", selection }, null, 2));
        return 2;
      }
      selectedIssueNumber = selection.selectedIssueNumber;
      if (cli.nextOnly) {
        console.log(JSON.stringify({ disposition: "pass", selectedIssueNumber, selection }, null, 2));
        return 0;
      }
    } else if (cli.nextOnly) {
      console.error("--next-only inspects automatic selection; omit --issue");
      return 2;
    }
    const options: BootstrapLifecycleOptions = {
      issueNumber: selectedIssueNumber,
      cwd: cli.cwd,
      allowRepair: cli.allowRepair,
      review: cli.review,
      verifyOnly: cli.verifyOnly,
      timeoutMs: cli.timeoutMs,
      finalize: cli.finalize,
    };
    const report = await runBootstrapLifecycle(options, { ...dependencies, reporter }, execute);
    console.log(JSON.stringify(report, null, 2));
    return exitCodeForDisposition(report.disposition);
  } catch (error) {
    if (selectedIssueNumber !== undefined) emitProgress(reporter, { issueNumber: selectedIssueNumber, phase: "terminal", state: "fail", detail: "blocked" });
    console.error(JSON.stringify({
      disposition: "blocked",
      code: error instanceof BootstrapError || error instanceof BootstrapLifecycleLockError ? error.code : "BOOTSTRAP_FAILED",
      reason: redact(error instanceof Error ? error.message : String(error)),
    }));
    return 2;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  return runBootstrapCli(args);
}

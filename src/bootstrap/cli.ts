import { resolve } from "node:path";
import { BootstrapCliOptions, BootstrapDependencies, BootstrapLifecycleOptions, BootstrapLifecycleReport, BootstrapOptions, BootstrapReport, Disposition, NextIssueSelection } from "./types.js";
import { BootstrapError } from "./errors.js";
import { redact, emitProgress } from "./utils.js";
import { createCliProgressReporter } from "./reporter.js";
import { resolveNextIssue } from "./roadmap.js";
import { runBootstrap } from "./supervisor.js";
import { BootstrapLifecycleLockError } from "./lifecycle-lock.js";
import { runSingleIssueLifecycle } from "../lifecycle/kernel.js";

function parseArgs(args: string[]): BootstrapCliOptions {
  let issueNumber: number | undefined;
  let allowRepair = true;
  let review = false;
  let verifyOnly = false;
  let nextOnly = false;
  let finalize = true;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--issue") issueNumber = Number(args[++index]);
    else if (arg === "--repair") allowRepair = true;
    else if (arg === "--no-repair") allowRepair = false;
    else if (arg === "--review") review = true;
    else if (arg === "--verify-only" || arg === "--resume") verifyOnly = true;
    else if (arg === "--next-only") nextOnly = true;
    else if (arg === "--no-finalize") finalize = false;
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (arg === "--cwd") {
      const value = args[++index];
      if (!value) throw new BootstrapError("--cwd requires a path");
      cwd = value;
    }
    else if (arg === "--queue") throw new BootstrapError("multi-issue --queue mode is intentionally not implemented");
    else throw new BootstrapError(`unknown option: ${arg}`);
  }
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber <= 0)) throw new BootstrapError("--issue must be a positive integer");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new BootstrapError("--timeout-ms must be positive");
  return { issueNumber, cwd, allowRepair, review, verifyOnly, timeoutMs, nextOnly, finalize };
}

export function exitCodeForDisposition(disposition: Disposition | "finalization-blocked" | "budget-yield"): number {
  return disposition === "pass" || disposition === "already-satisfied" ? 0 : disposition === "repairable-failure" ? 1 : 2;
}

export async function runBootstrapLifecycle(
  options: BootstrapLifecycleOptions,
  dependencies: BootstrapDependencies = {},
  execute: (options: BootstrapOptions, dependencies?: BootstrapDependencies) => Promise<BootstrapReport> = runBootstrap,
): Promise<BootstrapLifecycleReport> {
  const result = await runSingleIssueLifecycle({
    ...options,
    entry: "bootstrap",
    workItem: { issueNumber: options.issueNumber },
  }, dependencies, execute);
  return {
    issueNumber: result.issueNumber,
    disposition: result.disposition,
    implementation: result.implementation,
    verification: result.verification,
    finalization: result.finalization,
    candidatePreserved: result.candidatePreserved,
    repair: result.repair,
    implementationReport: result.implementationReport,
    finalizationReport: result.finalizationReport,
    finalizationFailure: result.finalizationFailure,
    workflowBudget: result.workflowBudget,
  };
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

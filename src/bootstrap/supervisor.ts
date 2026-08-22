import { relative, resolve } from "node:path";
import { BootstrapReport, BootstrapDependencies, BootstrapOptions, DEFAULT_PROGRESS_HEARTBEAT_MS, DEFAULT_TIMEOUT_MS, Disposition, Issue, RepositoryState, WorkerFactory, WorkerReport } from "./types.js";
import { runCommand } from "./command-runner.js";
import { emitProgress } from "./utils.js";
import { prepareRepository, prepareWorktree } from "./repository.js";
import { prepareDependencies } from "./dependencies.js";
import { fetchIssue } from "./authority.js";
import { loadContextFiles, buildWorkerPrompt } from "./task-packet.js";
import { createDefaultWorkerFactory } from "./worker-factory.js";
import { runWorker } from "./worker-runner.js";
import { runChecks, failureEvidence } from "./verification.js";
import { candidateEvidence, readCandidateState } from "./candidate.js";
import { reviewPassed } from "./reviewer.js";
import { CHECKS } from "./types.js";

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
  const dependencySetup = await prepareDependencies(worktree.path, runner, timeoutMs, options.signal)
    .then((setup) => {
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "dependencies", state: "ready", detail: setup.action });
      return setup;
    }, (error) => {
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "dependencies", state: "fail" });
      throw error;
    });

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
  const implementationCompleted = options.verifyOnly || initialWorker?.disposition === "completed";
  if (!checks.every((check) => check.passed) && options.allowRepair && implementationCompleted) {
    const repairPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "repair", failureEvidence(checks));
    await runWorker(await getFactory(), "repair", repairPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
    checks = await runChecks(worktree.path, runner, timeoutMs, options.issueNumber, reporter, heartbeatMs, options.signal);
  }
  const candidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
  const candidateHasDelta = candidate.changedFiles.length > 0 || candidate.committedChanges || candidate.uncommittedChanges;
  let reviewer: WorkerReport | undefined;
  if (options.review && candidateHasDelta && implementationCompleted && checks.every((check) => check.passed)) {
    const reviewEvidence = await candidateEvidence(worktree.path, repository.baselineRevision, candidate.headRevision, runner);
    const reviewPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "review", undefined, reviewEvidence);
    reviewer = await runWorker(await getFactory(), "review", reviewPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
  }

  const mechanicalPass = checks.length === CHECKS.length && checks.every((check) => check.passed);
  const reviewerResult = reviewer?.reviewResult;
  const reviewPass = options.review ? candidateHasDelta ? reviewer?.disposition === "completed" && reviewPassed(reviewerResult) : undefined : undefined;
  const closedByAuthority = issue.state === "CLOSED";
  const noChangeReason = !candidateHasDelta && mechanicalPass ? closedByAuthority ? "authoritative issue state is CLOSED; no candidate changes were produced" : "no candidate changes were produced and satisfaction was not mechanically proven" : undefined;
  const implementationOutcome: BootstrapReport["implementationOutcome"] = !implementationCompleted || !mechanicalPass ? "failed" : candidateHasDelta ? "implemented" : closedByAuthority ? "already-satisfied" : "unproven-no-change";
  const finalizationReady = implementationOutcome === "implemented" && mechanicalPass && !candidate.behindOriginMain && (options.review ? reviewPass === true : true);
  const disposition: Disposition = !implementationCompleted ? "blocked" : !mechanicalPass ? "repairable-failure" : !candidateHasDelta ? closedByAuthority ? "already-satisfied" : "no-change" : options.review && reviewPass !== true ? "blocked" : "pass";
  const reason = disposition === "pass" || disposition === "already-satisfied" ? undefined : noChangeReason ?? (reviewer && reviewPass !== true ? "independent review did not return a passing structured verdict" : initialWorker?.reason ?? (failureEvidence(checks) || "worker did not complete deterministic verification"));
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
    candidateReadyForReview: mechanicalPass && candidateHasDelta,
    finalizationReady,
    implementationOutcome,
    candidateHasDelta,
    noChangeReason,
    failureReason: reason,
  };
  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: disposition === "pass" || disposition === "already-satisfied" ? "pass" : "fail", detail: noChangeReason ?? disposition });
  return report;
}

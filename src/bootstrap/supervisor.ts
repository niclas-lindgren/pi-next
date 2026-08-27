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
import { DEFAULT_ZERO_DELTA_IMPLEMENTATION_RETRY_BUDGET, candidateHasDelta as hasCandidateDelta, decideZeroDeltaImplementationRetry, zeroDeltaRetryEvidence } from "./zero-delta-retry-policy.js";

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
    repository = await prepareRepository(cwd, runner, { issueNumber: options.issueNumber });
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "preflight", state: "pass" });
  } catch (error) {
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "preflight", state: "fail" });
    throw error;
  }

  if (repository.workflowBudget?.status === "exhausted") {
    // The shared workflow/lifecycle commit budget refused the incident
    // residue at the preflight boundary. Yield the single canonical typed
    // budget result now instead of launching a worker that could only
    // generate more un-committable residue or surface the boundary later as
    // an unrelated ROOT_DIRTY/finalization failure (#12). The residue stays
    // preserved as generated workflow state.
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: "fail", detail: `workflow/lifecycle commit budget exhausted; incident residue preserved as generated workflow state (${repository.workflowBudget.reason})` });
    return budgetExhaustedBootstrapReport(options.issueNumber, repository, started, now);
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

  let contextFiles = await loadContextFiles(worktree.path, issue);
  const workerAttempts: WorkerReport[] = [];
  let factory: WorkerFactory | undefined;
  const getFactory = async (): Promise<WorkerFactory> => {
    if (factory) return factory;
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worker", state: "start", detail: "factory" });
    factory = dependencies.createWorker ?? await createDefaultWorkerFactory();
    emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worker", state: "ready", detail: "factory" });
    return factory;
  };

  const preWorkerCandidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
  const resumeExistingCandidate = !options.verifyOnly && (preWorkerCandidate.changedFiles.length > 0 || preWorkerCandidate.committedChanges || preWorkerCandidate.uncommittedChanges);

  let initialWorker: WorkerReport | undefined;
  let retryWorker: WorkerReport | undefined;
  let implementationRetryEligibleReason: string | undefined;
  let implementationRetryBudgetExhausted = false;
  let implementationRetryBudgetUsed = 0;
  const implementationRetryBudget = options.implementationRetryBudget ?? DEFAULT_ZERO_DELTA_IMPLEMENTATION_RETRY_BUDGET;
  if (!options.verifyOnly && !resumeExistingCandidate) {
    const initialPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "implementation");
    initialWorker = await runWorker(await getFactory(), "implementation", initialPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
    const afterInitialCandidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
    if (!hasCandidateDelta(afterInitialCandidate) && initialWorker.disposition === "completed") {
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "issue", state: "start", detail: "zero-delta-retry-authority-refresh" });
      issue = dependencies.fetchIssue ? await dependencies.fetchIssue(options.issueNumber, repository.root) : await fetchIssue(options.issueNumber, repository.root, runner);
      contextFiles = await loadContextFiles(worktree.path, issue);
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "issue", state: "ready", detail: "zero-delta-retry-authority-refresh" });
    }
    const retryDecision = decideZeroDeltaImplementationRetry({
      worker: initialWorker,
      candidate: afterInitialCandidate,
      issue,
      retryBudgetUsed: implementationRetryBudgetUsed,
      retryBudget: implementationRetryBudget,
      satisfactionProven: issue.state === "CLOSED",
      implementationWorkerLaunched: true,
      repairOrFinalizationStarted: false,
      workspaceSafe: true,
      cancellationRequested: options.signal?.aborted,
    });
    implementationRetryBudgetExhausted = retryDecision.budgetExhausted;
    if (retryDecision.eligible) {
      implementationRetryEligibleReason = retryDecision.reason;
      implementationRetryBudgetUsed += 1;
      emitProgress(reporter, { issueNumber: options.issueNumber, phase: "worker", state: "start", role: "implementation-retry", detail: retryDecision.reason });
      const retryEvidence = zeroDeltaRetryEvidence({ previous: initialWorker, candidate: afterInitialCandidate, issue, reason: retryDecision.reason });
      const retryPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "implementation-retry", retryEvidence);
      retryWorker = await runWorker(await getFactory(), "implementation-retry", retryPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
      const afterRetryCandidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
      const exhaustedDecision = decideZeroDeltaImplementationRetry({
        worker: retryWorker,
        candidate: afterRetryCandidate,
        issue,
        retryBudgetUsed: implementationRetryBudgetUsed,
        retryBudget: implementationRetryBudget,
        satisfactionProven: issue.state === "CLOSED",
        implementationWorkerLaunched: true,
        repairOrFinalizationStarted: false,
        workspaceSafe: true,
        cancellationRequested: options.signal?.aborted,
      });
      implementationRetryBudgetExhausted = exhaustedDecision.budgetExhausted && retryWorker.disposition === "completed" && !hasCandidateDelta(afterRetryCandidate);
    }
  }
  let checks = await runChecks(worktree.path, runner, timeoutMs, options.issueNumber, reporter, heartbeatMs, options.signal);
  const latestImplementationWorker = retryWorker ?? initialWorker;
  const workerProtocolCompleted = options.verifyOnly || resumeExistingCandidate || latestImplementationWorker?.disposition === "completed";
  const operatorCancelled = !options.verifyOnly && !resumeExistingCandidate && (options.signal?.aborted === true || latestImplementationWorker?.disposition === "cancelled");
  const repairCandidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
  const repairCandidateHasDelta = hasCandidateDelta(repairCandidate);
  const timedOutCandidateRecoverable = latestImplementationWorker?.disposition === "timed_out" && repairCandidateHasDelta && !operatorCancelled;
  const implementationEvidenceSupportsVerification = workerProtocolCompleted || timedOutCandidateRecoverable;
  let repairOutcome: BootstrapReport["repairOutcome"] = checks.every((check) => check.passed) ? "not-needed" : options.allowRepair ? "ineligible" : "disabled";
  if (!checks.every((check) => check.passed) && options.allowRepair && implementationEvidenceSupportsVerification) {
    const evidence = failureEvidence(checks);
    if (repairCandidateHasDelta && evidence) {
      const currentCandidateEvidence = await candidateEvidence(worktree.path, repository.baselineRevision, repairCandidate.headRevision, runner);
      const repairPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "repair", evidence, currentCandidateEvidence);
      const repairWorker = await runWorker(await getFactory(), "repair", repairPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
      repairOutcome = repairWorker.disposition === "completed" ? "completed" : "failed";
      checks = await runChecks(worktree.path, runner, timeoutMs, options.issueNumber, reporter, heartbeatMs, options.signal);
      if (!checks.every((check) => check.passed)) repairOutcome = "exhausted";
    }
  }
  const candidate = await readCandidateState(worktree.path, repository.baselineRevision, runner);
  const candidateHasDelta = hasCandidateDelta(candidate);
  let reviewer: WorkerReport | undefined;
  const mechanicalPass = checks.length === CHECKS.length && checks.every((check) => check.passed);
  const candidateRecoveryAllowed = !operatorCancelled && (workerProtocolCompleted || (latestImplementationWorker?.disposition === "timed_out" && candidateHasDelta));
  if (options.review && candidateHasDelta && candidateRecoveryAllowed && mechanicalPass) {
    const reviewEvidence = await candidateEvidence(worktree.path, repository.baselineRevision, candidate.headRevision, runner);
    const reviewPrompt = buildWorkerPrompt(issue, worktree.path, contextFiles, "review", undefined, reviewEvidence);
    reviewer = await runWorker(await getFactory(), "review", reviewPrompt, worktree.path, timeoutMs, workerAttempts, options.issueNumber, reporter, heartbeatMs, options.signal);
  }

  const reviewerResult = reviewer?.reviewResult;
  const reviewPass = options.review ? candidateHasDelta ? reviewer?.disposition === "completed" && reviewPassed(reviewerResult) : undefined : undefined;
  const closedByAuthority = issue.state === "CLOSED";
  const noChangeReason = !candidateHasDelta && mechanicalPass ? closedByAuthority ? "authoritative issue state is CLOSED; no candidate changes were produced" : "no candidate changes were produced and satisfaction was not mechanically proven" : undefined;
  const candidateImplemented = candidateHasDelta && mechanicalPass && candidateRecoveryAllowed;
  const implementationOutcome: BootstrapReport["implementationOutcome"] = candidateImplemented ? "implemented" : !workerProtocolCompleted ? "failed" : implementationRetryBudgetExhausted ? "retry-exhausted" : mechanicalPass ? closedByAuthority ? "already-satisfied" : "unproven-no-change" : "failed";
  const finalizationReady = implementationOutcome === "implemented" && mechanicalPass && !candidate.behindOriginMain && (options.review ? reviewPass === true : true);
  const disposition: Disposition = operatorCancelled || (!workerProtocolCompleted && !candidateRecoveryAllowed) ? "blocked" : !mechanicalPass ? "repairable-failure" : !candidateHasDelta ? closedByAuthority ? "already-satisfied" : "no-change" : options.review && reviewPass !== true ? "blocked" : "pass";
  const verificationFailureReason = failureEvidence(checks);
  const reason = disposition === "pass" || disposition === "already-satisfied" ? undefined : (implementationRetryBudgetExhausted ? "implementation retry budget exhausted after repeated zero-delta completed attempts" : noChangeReason) ?? (reviewer && reviewPass !== true ? "independent review did not return a passing structured verdict" : !mechanicalPass ? verificationFailureReason ?? latestImplementationWorker?.reason ?? "worker did not complete deterministic verification" : latestImplementationWorker?.reason ?? "worker did not complete deterministic verification");
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
    candidateReadyForReview: mechanicalPass && candidateHasDelta && candidateRecoveryAllowed,
    finalizationReady,
    implementationOutcome,
    implementationAttemptCount: workerAttempts.filter((attempt) => attempt.role === "implementation" || attempt.role === "implementation-retry").length,
    implementationRetryEligibleReason,
    implementationRetryBudgetExhausted,
    repairOutcome,
    repairBudgetExhausted: repairOutcome === "exhausted",
    candidateHasDelta,
    noChangeReason,
    failureReason: reason,
  };
  emitProgress(reporter, { issueNumber: options.issueNumber, phase: "terminal", state: disposition === "pass" || disposition === "already-satisfied" ? "pass" : "fail", detail: noChangeReason ?? disposition });
  return report;
}

/**
 * Minimal typed report for a preflight workflow/lifecycle budget yield (#12):
 * no worker ran, nothing was written or destroyed, and the boundary is carried
 * on the report so the shared lifecycle maps it to the canonical
 * `budget-yield` result instead of a generic blocked/dirty interpretation.
 */
function budgetExhaustedBootstrapReport(
  issueNumber: number,
  repository: RepositoryState,
  started: Date,
  now: () => Date,
): BootstrapReport {
  const zero = "0".repeat(40);
  return {
    issueNumber,
    attempts: 0,
    start: started.toISOString(),
    end: now().toISOString(),
    disposition: "blocked",
    branch: `agent/issue-${issueNumber}`,
    worktree: `.worktrees/issue-${issueNumber}`,
    revision: zero,
    baselineRevision: repository.baselineRevision,
    candidate: {
      headRevision: zero,
      baselineRevision: repository.baselineRevision,
      originMainRevision: zero,
      mergeBaseRevision: zero,
      dirty: false,
      changedFiles: [],
      committedChanges: false,
      uncommittedChanges: false,
      committedFiles: [],
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      commitsAheadOfMergeBase: 0,
      commitsAheadOfOriginMain: 0,
      commitsBehindOriginMain: 0,
      behindOriginMain: false,
      divergedFromOriginMain: false,
    },
    dependencySetup: { action: "not-required" },
    workerAttempts: [],
    checks: [],
    mechanicalPass: false,
    candidateReadyForReview: false,
    finalizationReady: false,
    implementationOutcome: "unproven-no-change",
    candidateHasDelta: false,
    workflowBudget: repository.workflowBudget,
  };
}

import { REQUIRED_CHECKS } from "../coordination/required-checks.ts";
export const MAX_OUTPUT = 32_000;
export const MAX_FAILURE_EVIDENCE = 8_000;
export const MAX_PACKET_BYTES = 256_000;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_PROGRESS_HEARTBEAT_MS = 20_000;
export const MAX_CHANGED_FILES = 200;
export const CHECKS = REQUIRED_CHECKS;

export type Disposition = "pass" | "already-satisfied" | "no-change" | "repairable-failure" | "blocked";
export type WorkerRole = "implementation" | "implementation-retry" | "repair" | "review";
export type BootstrapProgressPhase = "preflight" | "worktree" | "dependencies" | "issue" | "worker" | "check" | "finalization" | "terminal";
export type BootstrapProgressState = "start" | "ready" | "activity" | "heartbeat" | "pass" | "fail" | "blocked" | "skipped" | "completed";

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
  state?: IssueState;
  labels?: string[];
}

export type IssueState = "OPEN" | "CLOSED";

export interface RoadmapIssue extends Issue {
  state: IssueState;
  labels?: string[];
}

export interface NextIssueSkipReason {
  issueNumber: number;
  status: "closed" | "blocked" | "not-eligible";
  reason: string;
}

export interface NextIssueSelection {
  selectedIssueNumber?: number;
  skips: NextIssueSkipReason[];
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

export interface BootstrapFinalizerLocalMainSync {
  status: "fast-forwarded" | "already-current" | "skipped";
  reason?: string;
  before?: string;
  after?: string;
}

export interface BootstrapFinalizerReport {
  ok: boolean;
  issueNumber: number;
  branch: string;
  candidateSha: string;
  merged: boolean;
  reachable: boolean;
  issueClosed: boolean;
  worktreeRemoved: boolean;
  localBranchRemoved: boolean;
  localMainSync?: BootstrapFinalizerLocalMainSync;
  outcome: "finalized" | "already-satisfied" | "integrated-pending-verification" | "integrated-authority-changed";
  pendingExternalVerification?: boolean;
}

import type { BootstrapLifecycleLock } from "./lifecycle-lock.js";

export type BootstrapFinalizer = (options: {
  cwd?: string;
  issueNumber?: number;
  candidatePaths?: string[];
  reporter?: (line: string) => void;
  lifecycleLock?: BootstrapLifecycleLock;
}) => Promise<BootstrapFinalizerReport>;

export interface BootstrapDependencies {
  runCommand?: CommandRunner;
  fetchIssue?: (issueNumber: number, cwd: string) => Promise<Issue>;
  fetchRoadmapIssues?: (cwd: string) => Promise<RoadmapIssue[]>;
  createWorker?: WorkerFactory;
  runFinalizer?: BootstrapFinalizer;
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
  verifyOnly?: boolean; implementationRetryBudget?: number;
  signal?: AbortSignal;
}

export interface BootstrapLifecycleOptions extends BootstrapOptions {
  finalize: boolean;
}

export interface BootstrapCliOptions {
  issueNumber?: number;
  cwd?: string;
  allowRepair: boolean;
  review: boolean;
  timeoutMs?: number;
  verifyOnly?: boolean;
  nextOnly: boolean;
  finalize: boolean;
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
  role: WorkerRole; disposition: "completed" | "failed" | "cancelled" | "timed_out";
  model?: string;
  durationMs: number; toolCalls: number;
  usage?: WorkerStats;
  reason?: string;
  telemetryWarning?: string;
  reviewResult?: ReviewerResult;
  stopReason?: string; terminalResultKind?: string;
  terminalResultObserved: boolean; assistantOutputObserved?: boolean;
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
  implementationOutcome: "implemented" | "already-satisfied" | "unproven-no-change" | "retry-exhausted" | "failed";
  implementationAttemptCount?: number; implementationRetryEligibleReason?: string; implementationRetryBudgetExhausted?: boolean;
  repairOutcome?: "not-needed" | "disabled" | "ineligible" | "completed" | "exhausted" | "failed";
  repairBudgetExhausted?: boolean;
  candidateHasDelta: boolean;
  noChangeReason?: string;
  failureReason?: string;
}

export interface BootstrapLifecycleReport {
  issueNumber: number;
  disposition: Disposition | "finalization-blocked";
  implementation: "PASS" | "FAIL" | "BLOCKED";
  verification: "PASS" | "FAIL";
  finalization: "PASS" | "BLOCKED" | "SKIPPED";
  candidatePreserved?: boolean;
  repair?: "NOT_NEEDED" | "DISABLED" | "INELIGIBLE" | "COMPLETED" | "EXHAUSTED" | "FAILED";
  implementationReport: BootstrapReport;
  finalizationReport?: BootstrapFinalizerReport;
  finalizationFailure?: { code: string; reason: string };
}

export interface RepositoryState {
  root: string;
  baselineRevision: string;
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
}

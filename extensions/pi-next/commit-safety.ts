import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  extractCommitEvidenceShas,
  missingAuthoritativeAcceptanceCriteria,
  verificationReportAuthorityErrors,
} from "./acceptance-verification.ts";
import { getLiveIssueFingerprint } from "./issue-freshness.ts";
import {
  acceptanceCriteria,
  currentTask,
  issueNumber,
  validatePlan,
} from "./plan.ts";
import {
  commitsReachableFromRef,
  errorOutput,
  formatUnreachableCommitDetails,
  git,
  gitMutation,
  planFile,
  psDir,
  qualityEvidenceFile,
  runHelper,
  verifyFile,
  writeJsonAtomic,
} from "./util-core.ts";
import {
  assertWorkflowCommitAllowed,
  classifyCommitPaths,
  type CommitKind,
  recordCommit,
} from "./workflow-commit-policy.ts";
import {
  changeFiles,
  conflictFiles,
  isEphemeralPath,
  normalizeRepoPath,
  pathMatches,
  safetyFindings,
  stagedFiles,
  unstagedFiles,
  untrackedFiles,
  workingFingerprint,
} from "./change-state.ts";

export const QUALITY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface QualityCommandEvidence {
  command: string;
  ok: boolean;
  durationMs: number;
  completedAt: string;
  reused?: boolean;
}

export interface QualityEvidence {
  level: "quick" | "standard" | "full";
  ok: boolean;
  fingerprint: string;
  completedAt: string;
  logPath: string;
  commands?: QualityCommandEvidence[];
}

export function readQualityEvidence(cwd: string): QualityEvidence | null {
  const path = qualityEvidenceFile(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as QualityEvidence;
  } catch {
    return null;
  }
}

export function writeQualityEvidence(
  cwd: string,
  evidence: QualityEvidence,
): void {
  writeJsonAtomic(qualityEvidenceFile(cwd), evidence);
}

export async function assertArchiveReady(
  cwd: string,
): Promise<{ plan: string; issue: number; fingerprint: string }> {
  const planPath = planFile(cwd);
  if (!existsSync(planPath)) throw new Error(`PLAN.md not found at ${planPath}`);
  const plan = readFileSync(planPath, "utf8");
  const errors = validatePlan(plan);
  if (errors.length) {
    throw new Error(
      `Cannot archive invalid plan:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
  if (currentTask(plan)) throw new Error("Cannot archive while unchecked tasks remain");
  const planCriteria = acceptanceCriteria(plan);
  const uncheckedCriteria = planCriteria.filter((criterion) => !criterion.checked);
  if (uncheckedCriteria.length) {
    throw new Error(
      `Cannot archive with unchecked acceptance criteria:\n${uncheckedCriteria.map((criterion) => `- ${criterion.text}`).join("\n")}`,
    );
  }
  const issue = issueNumber(plan);
  if (!issue) throw new Error("Cannot archive without a GitHub issue number");

  const fingerprint = await workingFingerprint(cwd);
  const verifyPath = verifyFile(cwd);
  if (!existsSync(verifyPath)) {
    throw new Error("Cannot archive without .ps-next/VERIFY.md");
  }
  const verify = readFileSync(verifyPath, "utf8");
  if (!/^STATUS:\s*PASS$/m.test(verify)) {
    throw new Error("Cannot archive unless verification status is PASS");
  }

  const liveIssue = await getLiveIssueFingerprint(cwd, issue).catch(() => null);
  if (!liveIssue) {
    throw new Error(
      "Cannot archive because live GitHub issue/comments authority could not be re-verified",
    );
  }

  const reportAuthorityErrors = verificationReportAuthorityErrors(
    verify,
    issue,
    liveIssue.fingerprint,
  );
  if (reportAuthorityErrors.length) {
    throw new Error(
      `Cannot archive invalid semantic verification evidence:\n${reportAuthorityErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  const missingAuthorityCriteria = missingAuthoritativeAcceptanceCriteria(
    liveIssue.acceptanceCriteria,
    planCriteria,
  );
  if (missingAuthorityCriteria.length) {
    throw new Error(
      `Cannot archive because PLAN.md omitted or reworded authoritative GitHub acceptance criteria:\n${missingAuthorityCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    );
  }

  const verifyFingerprint = verify.match(/^FINGERPRINT:\s*(\S+)$/m)?.[1];
  if (verifyFingerprint !== fingerprint) {
    throw new Error("Verification evidence is stale for the current code state");
  }

  const evidenceCommitShas = extractCommitEvidenceShas(verify);
  if (evidenceCommitShas.length) {
    const reachability = await commitsReachableFromRef(cwd, evidenceCommitShas, "origin/main");
    if (reachability.unreachable.length) {
      throw new Error(
        `Cannot archive because cited commit evidence is not reachable from origin/main:\n${formatUnreachableCommitDetails(reachability.unreachableDetails)}`,
      );
    }
  }

  const quality = readQualityEvidence(cwd);
  if (!quality || !quality.ok || quality.level !== "full") {
    throw new Error("Cannot archive without a passing full quality gate");
  }
  if (quality.fingerprint !== fingerprint) {
    throw new Error("Full quality evidence is stale for the current code state");
  }
  const age = Date.now() - Date.parse(quality.completedAt);
  if (!Number.isFinite(age) || age < 0 || age > QUALITY_MAX_AGE_MS) {
    throw new Error(
      "Full quality evidence is older than six hours; rerun it before archive",
    );
  }

  const changed = await changeFiles(cwd, "all");
  if (changed.length) {
    throw new Error(
      `Cannot archive with a dirty worktree:\n${changed.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  return { plan, issue, fingerprint };
}

export async function commitExplicitPaths(
  cwd: string,
  paths: string[],
  message: string,
  options: { issueNumber?: number; kind?: CommitKind } = {},
): Promise<string> {
  const normalized = [...new Set(paths.map(normalizeRepoPath))];
  const actualKind = classifyCommitPaths(normalized, cwd);
  // Caller labels are hints only. A substantive path can never be disguised
  // as bookkeeping; lifecycle is accepted only for an actually workflow-only
  // path set and remains subject to the same bounded bookkeeping budget.
  const kind: CommitKind = actualKind === "substantive"
    ? "substantive"
    : options.kind === "lifecycle"
      ? "lifecycle"
      : "workflow-only";
  const issue = options.issueNumber || issueNumber(readFileSync(planFile(cwd), "utf8")) || undefined;
  if (kind === "workflow-only" || kind === "lifecycle") assertWorkflowCommitAllowed(cwd, issue);
  if (!normalized.length) {
    throw new Error("At least one explicit commit path is required");
  }
  const forbidden = normalized.filter((path) => isEphemeralPath(path, cwd));
  if (forbidden.length) {
    throw new Error(
      `Ephemeral workflow paths cannot be committed:\n${forbidden.join("\n")}`,
    );
  }
  const conflicts = await conflictFiles(cwd);
  if (conflicts.length) {
    throw new Error(`Cannot commit with conflicts:\n${conflicts.join("\n")}`);
  }
  const preStaged = await stagedFiles(cwd);
  if (preStaged.length) {
    throw new Error(
      `Refusing to mix with pre-staged changes:\n${preStaged.join("\n")}`,
    );
  }

  const available = [
    ...new Set([...(await unstagedFiles(cwd)), ...(await untrackedFiles(cwd))]),
  ];
  const selected = available.filter((file) =>
    normalized.some((path) => pathMatches(path, file)),
  );
  if (!selected.length) return "";
  const selectedForbidden = selected.filter((path) => isEphemeralPath(path, cwd));
  if (selectedForbidden.length) {
    throw new Error(
      `Selected changes contain ephemeral paths:\n${selectedForbidden.join("\n")}`,
    );
  }

  await gitMutation(cwd, ["add", "--", ...normalized]);
  try {
    const staged = await stagedFiles(cwd);
    const outside = staged.filter(
      (file) => !normalized.some((path) => pathMatches(path, file)),
    );
    if (outside.length) {
      throw new Error(`Staging escaped the explicit path set:\n${outside.join("\n")}`);
    }
    const stagedForbidden = staged.filter((path) => isEphemeralPath(path, cwd));
    if (stagedForbidden.length) {
      throw new Error(
        `Staged changes contain ephemeral paths:\n${stagedForbidden.join("\n")}`,
      );
    }
    const { findings } = await safetyFindings(cwd, "staged");
    if (findings.length) {
      throw new Error(`Staged safety scan failed:\n${findings.join("\n")}`);
    }
    await gitMutation(cwd, ["commit", "-m", message]);
  } catch (error) {
    await gitMutation(cwd, ["reset", "--", ...normalized]).catch(() => "");
    throw error;
  }
  const hash = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  recordCommit(cwd, issue, kind);
  return hash;
}

export async function archiveAndCommit(
  cwd: string,
): Promise<{ archive: string; hash: string; issue: number }> {
  const ready = await assertArchiveReady(cwd);
  const localPs = psDir(cwd);
  const planPath = planFile(cwd);
  const relativePs = relative(cwd, localPs).split(sep).join("/");
  if (!relativePs || relativePs.startsWith("../") || isAbsolute(relativePs)) {
    throw new Error("Archive commits require the repository-local .ps-next directory");
  }

  const { stdout } = await runHelper(cwd, "pi-next-archive.sh", [localPs]);
  const archive = stdout.trim();
  const archiveRelative = relative(cwd, archive).split(sep).join("/");
  const paths = [
    relative(cwd, planPath).split(sep).join("/"),
    `${relativePs}/HISTORY.md`,
    archiveRelative,
  ];
  let hash: string;
  try {
    hash = await commitExplicitPaths(
      cwd,
      paths,
      `chore(agent): archive issue #${ready.issue} plan`,
      { issueNumber: ready.issue, kind: "lifecycle" },
    );
    if (!hash) throw new Error("Archive produced no commit");
  } catch (error) {
    throw new Error(
      `Archive files were created but the archive commit failed; inspect git status before retrying. ${errorOutput(error)}`,
    );
  }

  try {
    await gitMutation(cwd, ["push", "origin", "HEAD:main"]);
  } catch (error) {
    throw new Error(
      `Archive commit ${hash} was created locally but could not be pushed to origin/main; the closure boundary cannot trust an unpushed archive commit. ${errorOutput(error)}`,
    );
  }
  return { archive, hash, issue: ready.issue };
}

export function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

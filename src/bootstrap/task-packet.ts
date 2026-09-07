import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BootstrapError } from "./errors.js";
import { Issue, IssueComment, MAX_PACKET_BYTES, WorkerRole } from "./types.js";
import { isDirectory } from "./git-utils.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const CONTEXT_REPORT_VERSION = 1;

function commentText(comment: IssueComment): string {
  const author = comment.author?.login ? `@${comment.author.login}` : "unknown";
  const date = comment.createdAt ?? comment.updatedAt ?? "";
  return `Comment by ${author}${date ? ` (${date})` : ""}:\n${comment.body ?? ""}`;
}

export interface ContextContribution {
  category: "issue-title" | "issue-body" | "issue-comments" | "repository-instructions" | "selected-skills" | "failure-evidence" | "candidate-evidence" | "kernel-overhead";
  id: string;
  chars: number;
  bytes: number;
  estimatedTokens: number;
}

export interface WorkerContextBudgetReport {
  version: number;
  issueNumber: number;
  role: WorkerRole;
  maxPacketBytes: number;
  totalChars: number;
  totalBytes: number;
  estimatedTokens: number;
  contributions: ContextContribution[];
  dominantContributors: ContextContribution[];
}

function contribution(category: ContextContribution["category"], id: string, text: string): ContextContribution {
  const chars = text.length;
  const bytes = Buffer.byteLength(text);
  return {
    category,
    id,
    chars,
    bytes,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE),
  };
}

function summarizeDominant(contributions: ContextContribution[], count = 5): ContextContribution[] {
  return [...contributions].sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.chars - a.chars).slice(0, count);
}

export function formatContextBudgetSummary(report: WorkerContextBudgetReport): string {
  const top = report.dominantContributors
    .map((item) => `${item.id} ${item.category} ~${item.estimatedTokens} tokens`)
    .join("; ");
  return `context budget ~${report.estimatedTokens} tokens (${report.totalBytes}/${report.maxPacketBytes} bytes)${top ? `; top: ${top}` : ""}`;
}

async function persistContextBudgetReport(cwd: string, report: WorkerContextBudgetReport): Promise<void> {
  const dir = resolve(cwd, ".pi", "runtime", "worker-context");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, `issue-${report.issueNumber}-${report.role}.budget.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

export async function loadContextFiles(cwd: string, issue: Issue): Promise<Array<{ path: string; content: string }>> {
  const root = resolve(cwd);
  const agentsPath = resolve(root, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  const references = new Set<string>();
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
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (total > MAX_PACKET_BYTES) {
    const dominant = summarizeDominant(files.map((file) => contribution("repository-instructions", file.path, file.content)));
    throw new BootstrapError(`bounded worker context packet is too large (${total}/${MAX_PACKET_BYTES} bytes); dominant contributors: ${dominant.map((item) => `${item.id} ~${item.estimatedTokens} tokens`).join("; ")}`);
  }
  return files;
}

function workerContextFile(file: { path: string; content: string }, role: WorkerRole): { path: string; content: string } {
  if (file.path !== "AGENTS.md" || role === "review") return file;
  return {
    ...file,
    content: file.content.replace(/\n## Required issue loop\n[\s\S]*?(?=\n## Controller and recovery regression testing\n|$)/, "\n## Required issue loop\n\nLifecycle progression, authority refresh, promotion, closure, and cleanup are kernel-owned and are intentionally omitted from this coding-worker packet.\n"),
  };
}

function roleInstruction(role: WorkerRole): string {
  return role === "review"
    ? "Review the exact candidate evidence for correctness and contract violations. Do not edit files. Use the structured result contract: {\"verdict\":\"pass\"} or {\"verdict\":\"findings\",\"findings\":[{\"severity\":\"blocking\"|\"warning\",\"path\":\"optional\",\"summary\":\"concise bounded finding\"}]}."
    : role === "repair"
      ? "This is one fresh repair attempt. Inspect the current worktree and repair only the reported deterministic failures."
      : role === "implementation-retry"
        ? "This is one fresh bounded implementation retry after a completed zero-delta attempt. Implement the issue completely in this worktree; do not merely inspect or report completion."
        : "Implement the issue completely in this worktree.";
}

function promptParts(issue: Issue, cwd: string, contextFiles: Array<{ path: string; content: string }>, role: WorkerRole, failureEvidence?: string, candidate?: string): string[] {
  const comments = issue.comments.length ? issue.comments.map(commentText).join("\n\n") : "(no comments)";
  const context = contextFiles.map((file) => workerContextFile(file, role)).map((file) => `--- BEGIN ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n");
  const packet = [
    `You are the ${role} worker for pi-next issue #${issue.number}.`,
    roleInstruction(role),
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
  return packet;
}

export function analyzeWorkerContextBudget(issue: Issue, cwd: string, contextFiles: Array<{ path: string; content: string }>, role: WorkerRole, failureEvidence?: string, candidate?: string): WorkerContextBudgetReport {
  const comments = issue.comments.length ? issue.comments.map(commentText).join("\n\n") : "(no comments)";
  const rewrittenContextFiles = contextFiles.map((file) => workerContextFile(file, role));
  const fullPrompt = promptParts(issue, cwd, contextFiles, role, failureEvidence, candidate).join("\n");
  const measured = [
    contribution("issue-title", `#${issue.number} title`, issue.title),
    contribution("issue-body", `#${issue.number} body`, issue.body),
    contribution("issue-comments", `${issue.comments.length} issue comments`, comments),
    ...rewrittenContextFiles.map((file) => contribution("repository-instructions", file.path, file.content)),
    contribution("selected-skills", `${role} selected methodology`, ""),
    ...(failureEvidence ? [contribution("failure-evidence", "deterministic failure evidence", failureEvidence)] : []),
    ...(candidate ? [contribution("candidate-evidence", "exact candidate evidence", candidate)] : []),
  ];
  const measuredChars = measured.reduce((sum, item) => sum + item.chars, 0);
  const overheadText = fullPrompt.length > measuredChars ? "x".repeat(fullPrompt.length - measuredChars) : "";
  const contributions = [...measured, contribution("kernel-overhead", "dispatch prompt overhead", overheadText)];
  return {
    version: CONTEXT_REPORT_VERSION,
    issueNumber: issue.number,
    role,
    maxPacketBytes: MAX_PACKET_BYTES,
    totalChars: fullPrompt.length,
    totalBytes: Buffer.byteLength(fullPrompt),
    estimatedTokens: Math.ceil(fullPrompt.length / CHARS_PER_TOKEN_ESTIMATE),
    contributions,
    dominantContributors: summarizeDominant(contributions),
  };
}

export async function persistWorkerContextBudgetReport(cwd: string, report: WorkerContextBudgetReport): Promise<void> {
  await persistContextBudgetReport(cwd, report);
}

export function buildWorkerPrompt(issue: Issue, cwd: string, contextFiles: Array<{ path: string; content: string }>, role: WorkerRole, failureEvidence?: string, candidate?: string): string {
  const prompt = promptParts(issue, cwd, contextFiles, role, failureEvidence, candidate).join("\n");
  if (prompt.length > MAX_PACKET_BYTES) {
    const report = analyzeWorkerContextBudget(issue, cwd, contextFiles, role, failureEvidence, candidate);
    throw new BootstrapError(`worker task packet is too large (${report.totalBytes}/${MAX_PACKET_BYTES} bytes, ~${report.estimatedTokens} tokens); dominant contributors: ${report.dominantContributors.map((item) => `${item.id} ${item.category} ~${item.estimatedTokens} tokens`).join("; ")}`);
  }
  return prompt;
}

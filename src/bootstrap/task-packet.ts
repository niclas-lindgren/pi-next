import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BootstrapError } from "./errors.js";
import { Issue, IssueComment, MAX_PACKET_BYTES, WorkerRole } from "./types.js";
import { isDirectory } from "./git-utils.js";

function commentText(comment: IssueComment): string {
  const author = comment.author?.login ? `@${comment.author.login}` : "unknown";
  const date = comment.createdAt ?? comment.updatedAt ?? "";
  return `Comment by ${author}${date ? ` (${date})` : ""}:\n${comment.body ?? ""}`;
}

export async function loadContextFiles(cwd: string, issue: Issue): Promise<Array<{ path: string; content: string }>> {
  const root = resolve(cwd);
  const agentsPath = resolve(root, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  const references = new Set<string>(["docs/EVALUATION_AND_RELIABILITY.md"]);
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
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_PACKET_BYTES) throw new BootstrapError("bounded worker context packet is too large");
  return files;
}

export function buildWorkerPrompt(issue: Issue, cwd: string, contextFiles: Array<{ path: string; content: string }>, role: WorkerRole, failureEvidence?: string, candidate?: string): string {
  const comments = issue.comments.length ? issue.comments.map(commentText).join("\n\n") : "(no comments)";
  const context = contextFiles.map((file) => `--- BEGIN ${file.path} ---\n${file.content}\n--- END ${file.path} ---`).join("\n\n");
  const roleInstruction = role === "review"
    ? "Review the exact candidate evidence for correctness and contract violations. Do not edit files, run mutating commands, merge, push, close issues, or claim acceptance. Return only the structured result contract: {\"verdict\":\"pass\"} or {\"verdict\":\"findings\",\"findings\":[{\"severity\":\"blocking\"|\"warning\",\"path\":\"optional\",\"summary\":\"concise bounded finding\"}]}. Do not include transcript, hidden reasoning, or unbounded prose."
    : role === "repair"
      ? "This is one fresh repair attempt. Inspect the current worktree and repair only the reported deterministic failures. Do not merge, push, close the issue, release authority, finalize, or grade your own work."
      : "Implement the issue completely in this worktree. Do not merge, push, close the issue, release authority, finalize, or grade your own work.";
  const packet = [
    `You are the ${role} worker for pi-next issue #${issue.number}.`,
    roleInstruction,
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
  const prompt = packet.join("\n");
  if (prompt.length > MAX_PACKET_BYTES) throw new BootstrapError("worker task packet is too large");
  return prompt;
}

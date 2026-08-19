import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  git,
  gitRaw,
} from "./util-core";

const MAX_UNTRACKED_SCAN_BYTES = 1_000_000;
const WORKFLOW_META_PREFIXES = [
  ".ps-next/ARCHIVED/",
  ".ps-next/deferred/",
  ".pi/runtime/",
  ".pi/logs/",
];
const WORKFLOW_META_FILES = new Set([
  ".ps-next/PLAN.md",
  ".ps-next/VERIFY.md",
  ".ps-next/HISTORY.md",
  ".ps-next/.lock",
  ".ps-next/.continue-here.md",
]);
const EPHEMERAL_PATHS = new Set([
  ".ps-next/.lock",
  ".ps-next/.continue-here.md",
]);
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]+/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |OPENSSH |EC |)PRIVATE KEY-----/,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{12,}/i,
];
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.|$)/,
  /\.pem$/,
  /id_rsa/,
  /auth\.json$/,
  /credentials\.json$/,
  /\.pi\/runtime\//,
  /^\.ps-next\/(?:\.lock|\.continue-here\.md)$/,
];

export type ChangeScope = "all" | "staged" | "unstaged";

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export async function stagedFiles(cwd: string): Promise<string[]> {
  return splitNull(await gitRaw(cwd, ["diff", "--cached", "--name-only", "-z"]));
}

export async function unstagedFiles(cwd: string): Promise<string[]> {
  return splitNull(await gitRaw(cwd, ["diff", "--name-only", "-z"]));
}

export async function untrackedFiles(cwd: string): Promise<string[]> {
  return splitNull(
    await gitRaw(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
}

export async function conflictFiles(cwd: string): Promise<string[]> {
  return splitNull(
    await gitRaw(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]),
  );
}

export async function changeFiles(
  cwd: string,
  scope: ChangeScope,
): Promise<string[]> {
  const lists =
    scope === "staged"
      ? [await stagedFiles(cwd)]
      : scope === "unstaged"
        ? [await unstagedFiles(cwd), await untrackedFiles(cwd)]
        : [
            await stagedFiles(cwd),
            await unstagedFiles(cwd),
            await untrackedFiles(cwd),
          ];
  return [...new Set(lists.flat())].sort();
}

export function normalizeRepoPath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!trimmed) throw new Error("Commit paths cannot be empty");
  if (
    isAbsolute(trimmed) ||
    trimmed === ".." ||
    trimmed.startsWith("../") ||
    trimmed.includes("/../")
  ) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  if (/[*?\[\]{}]/.test(trimmed)) {
    throw new Error(`Globs are not allowed in commit paths: ${value}`);
  }
  return trimmed;
}

export function pathMatches(requested: string, actual: string): boolean {
  return actual === requested || actual.startsWith(`${requested}/`);
}

export function isEphemeralPath(path: string): boolean {
  return (
    EPHEMERAL_PATHS.has(path) ||
    path.startsWith(".pi/runtime/") ||
    path.startsWith(".pi/logs/")
  );
}

export function isWorkflowMetaPath(path: string): boolean {
  return (
    (WORKFLOW_META_FILES.has(path) || /^\.ps-next\/PLAN-[^/]+\.md$/.test(path)) ||
    WORKFLOW_META_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function readFilePrefix(path: string, maxBytes: number): string {
  const stats = statSync(path);
  if (!stats.isFile()) return "";
  const length = Math.min(stats.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function addedLinesFromDiff(diff: string): string {
  const additions: string[] = [];
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith("+")) additions.push(line.slice(1));
  }
  return additions.join("\n");
}

async function secretScanText(
  cwd: string,
  scope: ChangeScope,
): Promise<string> {
  const pieces: string[] = [];
  const diffArgs = ["--unified=0", "--no-color", "--no-ext-diff"];
  if (scope === "all" || scope === "staged") {
    pieces.push(
      addedLinesFromDiff(
        await gitRaw(cwd, ["diff", "--cached", ...diffArgs], 8 * 1024 * 1024),
      ),
    );
  }
  if (scope === "all" || scope === "unstaged") {
    pieces.push(
      addedLinesFromDiff(
        await gitRaw(cwd, ["diff", ...diffArgs], 8 * 1024 * 1024),
      ),
    );
    let remaining = MAX_UNTRACKED_SCAN_BYTES;
    for (const file of await untrackedFiles(cwd)) {
      if (remaining <= 0) break;
      const absolute = join(cwd, file);
      if (!existsSync(absolute)) continue;
      const text = readFilePrefix(absolute, remaining);
      remaining -= Buffer.byteLength(text);
      pieces.push(text);
    }
  }
  return pieces.join("\n");
}

export async function diffText(
  cwd: string,
  scope: ChangeScope,
): Promise<string> {
  const pieces: string[] = [];
  if (scope === "all" || scope === "staged") {
    pieces.push(
      await gitRaw(cwd, ["diff", "--cached", "--binary"], 8 * 1024 * 1024),
    );
  }
  if (scope === "all" || scope === "unstaged") {
    pieces.push(await gitRaw(cwd, ["diff", "--binary"], 8 * 1024 * 1024));
    let remaining = MAX_UNTRACKED_SCAN_BYTES;
    for (const file of await untrackedFiles(cwd)) {
      if (remaining <= 0) break;
      const absolute = join(cwd, file);
      if (!existsSync(absolute)) continue;
      const text = readFilePrefix(absolute, remaining);
      remaining -= Buffer.byteLength(text);
      pieces.push(`\n--- untracked: ${file}\n${text}`);
    }
  }
  return pieces.join("\n");
}

export async function safetyFindings(
  cwd: string,
  scope: ChangeScope,
): Promise<{ findings: string[]; files: string[] }> {
  const files = await changeFiles(cwd, scope);
  const findings = files
    .filter((file) =>
      SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(file)),
    )
    .map((file) => `Sensitive or ephemeral file changed: ${file}`);
  const introducedText = await secretScanText(cwd, scope);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(introducedText)) {
      findings.push(`Potential secret pattern: ${pattern}`);
    }
  }
  return { findings: [...new Set(findings)], files };
}

export async function diffSummary(
  cwd: string,
  scope: ChangeScope,
): Promise<{ files: string[]; stat: string; text: string }> {
  const files = await changeFiles(cwd, scope);
  const statParts: string[] = [];
  if (scope === "all" || scope === "staged") {
    const staged = await git(cwd, ["diff", "--cached", "--stat"]);
    if (staged) statParts.push(`Staged:\n${staged}`);
  }
  if (scope === "all" || scope === "unstaged") {
    const unstaged = await git(cwd, ["diff", "--stat"]);
    if (unstaged) statParts.push(`Unstaged:\n${unstaged}`);
    const untracked = await untrackedFiles(cwd);
    if (untracked.length) {
      statParts.push(`Untracked (${untracked.length}):\n${untracked.join("\n")}`);
    }
  }
  return { files, stat: statParts.join("\n\n"), text: await diffText(cwd, scope) };
}

export async function workingFingerprint(cwd: string): Promise<string> {
  const hash = createHash("sha256");
  const tracked = splitNull(await gitRaw(cwd, ["ls-files", "-s", "-z"]));
  for (const entry of tracked.sort()) {
    const tab = entry.indexOf("\t");
    const path = tab >= 0 ? entry.slice(tab + 1) : "";
    if (!path || isWorkflowMetaPath(path)) continue;
    hash.update(entry);
    hash.update("\0");
  }

  const pathspec = [
    "--",
    ".",
    ":(exclude).ps-next/**",
    ":(exclude).pi/runtime/**",
    ":(exclude).pi/logs/**",
  ];
  hash.update(
    await gitRaw(cwd, ["diff", "--binary", ...pathspec], 16 * 1024 * 1024),
  );
  hash.update(
    await gitRaw(
      cwd,
      ["diff", "--cached", "--binary", ...pathspec],
      16 * 1024 * 1024,
    ),
  );

  for (const file of (await untrackedFiles(cwd))
    .filter((path) => !isWorkflowMetaPath(path))
    .sort()) {
    hash.update(file);
    hash.update("\0");
    const object = await git(cwd, ["hash-object", "--no-filters", "--", file]);
    hash.update(object);
    hash.update("\0");
  }
  return hash.digest("hex");
}

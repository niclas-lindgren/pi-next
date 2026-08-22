#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_ROOTS = ["src", "scripts", "extensions"];
const DEFAULT_ALLOWLIST = "scripts/file-size-allowlist.json";
const MAX_LINES = Number(process.env.PI_NEXT_MAX_SOURCE_LINES ?? 300);

function parseArgs(argv) {
  const roots = [];
  let allowlist = DEFAULT_ALLOWLIST;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allowlist") allowlist = argv[++index];
    else roots.push(arg);
  }
  return { roots: roots.length ? roots : DEFAULT_ROOTS, allowlist };
}

async function readAllowlist(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("allowlist must be an object");
    for (const [file, reason] of Object.entries(parsed)) {
      if (typeof reason !== "string" || reason.trim().length < 12) {
        throw new Error(`allowlist entry ${file} needs a reviewable reason`);
      }
    }
    return parsed;
  } catch (error) {
    if (path === DEFAULT_ALLOWLIST && error.code === "ENOENT") return {};
    throw error;
  }
}

function excluded(path) {
  return path.includes("/node_modules/")
    || path.includes("/.git/")
    || path.includes("/.worktrees/")
    || path.includes("/dist/")
    || path.includes("/build/")
    || path.includes("/coverage/")
    || path.includes("/fixtures/")
    || path.includes("/__fixtures__/")
    || path.includes("/__snapshots__/")
    || path.endsWith(".d.ts");
}

async function* walk(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (excluded(`/${path}`)) continue;
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && path.endsWith(".ts")) yield path;
  }
}

async function lineCount(path) {
  const text = await readFile(path, "utf8");
  if (text.length === 0) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

const { roots, allowlist: allowlistPath } = parseArgs(process.argv.slice(2));
const allowlist = await readAllowlist(allowlistPath);
const offenders = [];
const lineCounts = new Map();
const seen = new Set();

for (const root of roots) {
  const rootStat = await stat(root).catch(() => undefined);
  if (rootStat?.isFile()) {
    if (root.endsWith(".ts") && !excluded(`/${root}`)) {
      const path = relative(process.cwd(), root).replaceAll("\\", "/");
      seen.add(path);
      const lines = await lineCount(root);
      lineCounts.set(path, lines);
      if (lines > MAX_LINES && !(path in allowlist)) offenders.push({ path, lines });
    }
    continue;
  }
  for await (const file of walk(root)) {
    const path = relative(process.cwd(), file).replaceAll("\\", "/");
    seen.add(path);
    const lines = await lineCount(file);
    lineCounts.set(path, lines);
    if (lines > MAX_LINES && !(path in allowlist)) offenders.push({ path, lines });
  }
}

const stale = Object.keys(allowlist).filter((path) => !seen.has(path)).sort();
const obsolete = Object.keys(allowlist).filter((path) => seen.has(path) && (lineCounts.get(path) ?? 0) <= MAX_LINES).sort();
if (stale.length || obsolete.length) {
  if (stale.length) {
    console.error("File-size allowlist contains paths outside the checked source set:");
    for (const path of stale) console.error(`  ${path}`);
  }
  if (obsolete.length) {
    console.error(`File-size allowlist contains paths at or below ${MAX_LINES} lines:`);
    for (const path of obsolete) console.error(`  ${path}: ${lineCounts.get(path)} lines`);
  }
  process.exitCode = 1;
} else if (offenders.length) {
  console.error(`Handwritten TypeScript files over ${MAX_LINES} lines require a scripts/file-size-allowlist.json reason:`);
  for (const offender of offenders.sort((a, b) => a.path.localeCompare(b.path))) {
    console.error(`  ${offender.path}: ${offender.lines} lines`);
  }
  process.exitCode = 1;
}

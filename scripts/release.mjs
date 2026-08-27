#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePreparedReleaseNotes, validateReleaseNotes } from "./release-notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const level = args.find((arg) => !arg.startsWith("--"));
const flags = new Set(args.filter((arg) => arg.startsWith("--")));

if (!level || !["patch", "minor", "major"].includes(level) || [...flags].some((flag) => !["--dry-run", "--push", "--publish"].includes(flag))) {
  console.error("Usage: npm run release -- <patch|minor|major> [--dry-run] [--push] [--publish]");
  console.error("Set RELEASE_NOTES to the free-form notes text; empty text creates a section-only entry.");
  process.exit(2);
}
if (flags.has("--publish") && !flags.has("--push")) {
  console.error("--publish requires --push so the published tag exists on origin first");
  process.exit(2);
}

function git(...gitArgs) {
  return execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" }).trim();
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { cwd: root, stdio: "inherit" });
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
    throw new Error(`package.json has an unsupported stable version: ${manifest.version}`);
  }
  return manifest.version;
}

function nextVersion(current, bump) {
  const parts = current.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  parts[index] += 1;
  if (index === 0) { parts[1] = 0; parts[2] = 0; }
  if (index === 1) parts[2] = 0;
  return parts.join(".");
}

function incidentDiagnosticsPrefix() {
  let diagnosticsPath = ".pi-next/diagnostics";
  try {
    const config = JSON.parse(readFileSync(join(root, ".pi-next", "config.json"), "utf8"));
    if (typeof config?.workflow?.diagnosticsPath === "string") diagnosticsPath = config.workflow.diagnosticsPath;
  } catch {
    // No local override; the default diagnostics path stands.
  }
  return `${diagnosticsPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")}/incidents/`;
}

/**
 * Autonomous bootstrap/monitor runs can leave sanitized incident-diagnostic
 * residue in the coordination root between release attempts (#145). Rather
 * than hard-fail every release on this one well-understood, safe-to-absorb
 * case, commit and push it exactly like the runtime's own
 * commitIncidentDiagnosticsBeforeFinalization guard: only when every dirty
 * path is under the incident-diagnostics prefix, on main, and local main is
 * exactly origin/main. Any other dirty state still fails the check below.
 */
function absorbIncidentDiagnosticsResidue() {
  // Porcelain status lines are a fixed 2-character status code (which may
  // itself start with a space, e.g. " M path") followed by a space and the
  // path. Trimming the whole multi-line output - as the shared git() helper
  // does - eats that leading space off only the first line and corrupts its
  // path, so this reads raw output directly instead.
  const raw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).replace(/\n+$/, "");
  if (!raw) return;
  const paths = raw.split("\n")
    .map((line) => line.slice(3).split(" -> ").at(-1)?.replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (!paths.length) return;
  const prefix = incidentDiagnosticsPrefix();
  if (paths.some((path) => !path.startsWith(prefix))) return;
  try {
    git("fetch", "origin", "main", "--quiet");
    if (git("rev-parse", "HEAD") !== git("rev-parse", "refs/remotes/origin/main")) return;
    git("add", "--", ...paths);
    if (!git("diff", "--cached", "--name-only")) return;
    git("commit", "-m", "chore(agent): record finalization incident diagnostics");
    git("push", "origin", "HEAD:main");
    console.log(`Absorbed incident-diagnostics-only residue before release: ${paths.join(", ")}`);
  } catch (error) {
    // Best-effort only; the clean-tree check below remains the source of truth.
    console.warn(`Could not absorb incident-diagnostics residue automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
    throw new Error("releases must be prepared from the main branch");
  }
  absorbIncidentDiagnosticsResidue();
  if (git("status", "--porcelain")) {
    throw new Error("working tree must be clean before releasing");
  }

  const current = packageVersion();
  const version = nextVersion(current, level);
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  const preparedReleaseNotes = ensurePreparedReleaseNotes(changelog, version, process.env.RELEASE_NOTES || "");
  validateReleaseNotes(preparedReleaseNotes.changelog, current, version);
  const tag = `v${version}`;
  if (git("tag", "--list", tag) === tag) {
    throw new Error(`tag ${tag} already exists`);
  }

  console.log(`Release ${current} -> ${version}`);
  console.log(preparedReleaseNotes.changed ? "Release notes will be prepared in CHANGELOG.md." : "Release notes already prepared in CHANGELOG.md.");
  console.log("Release notes validated for the shipped and prepared versions.");
  if (flags.has("--dry-run")) {
    console.log("Dry run: no files, commits, tags, pushes, or publishes changed.");
    process.exit(0);
  }

  run("npm", ["run", "qualify:release"]);
  run("npm", ["test"]);
  if (preparedReleaseNotes.changed) {
    writeFileSync(changelogPath, preparedReleaseNotes.changelog);
  }
  run("npm", ["version", version, "--no-git-tag-version"]);
  run("git", ["add", "CHANGELOG.md", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore(release): v${version}`]);
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);

  if (flags.has("--push")) {
    run("git", ["push", "origin", "main", "--follow-tags"]);
    console.log(`Pushed ${tag}. Do not move refs/tags/supported until the hosted tag Release gate passes for this exact tag and commit.`);
    console.log(`After that gate passes, publish the consumer channel explicitly: git tag -f supported ${tag} && git push origin refs/tags/supported --force`);
  } else {
    console.log(`Created release commit and ${tag}. Push with: git push origin main --follow-tags`);
    console.log(`After the hosted tag Release gate passes, move refs/tags/supported to ${tag} before declaring it consumer-supported.`);
  }
  if (flags.has("--publish")) {
    run("npm", ["publish", "--access", "public"]);
  }
} catch (error) {
  console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

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

try {
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
    throw new Error("releases must be prepared from the main branch");
  }
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

  run("npm", ["run", "typecheck"]);
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
  } else {
    console.log(`Created release commit and ${tag}. Push with: git push origin main --follow-tags`);
  }
  if (flags.has("--publish")) {
    run("npm", ["publish", "--access", "public"]);
  }
} catch (error) {
  console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseNotes } from "./release-notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return manifest.version;
}

try {
  const version = packageVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unsupported package version: ${version}`);
  const tag = `v${version}`;
  const expectedTag = process.env.PI_NEXT_RELEASE_TAG || process.env.GITHUB_REF_NAME;
  if (!expectedTag) throw new Error("exact release tag is required (set GITHUB_REF_NAME or PI_NEXT_RELEASE_TAG)");
  if (expectedTag !== tag) throw new Error(`package.json ${version} does not match release tag ${expectedTag}`);

  const head = git("rev-parse", "HEAD");
  const taggedCommit = git("rev-list", "-n", "1", `refs/tags/${tag}`);
  if (head !== taggedCommit) throw new Error(`checked-out commit ${head} is not the commit targeted by ${tag}`);

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  validateReleaseNotes(changelog, version, version);
  console.log(`Verified ${tag} at ${head}; release notes are present.`);
} catch (error) {
  console.error(`Release verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

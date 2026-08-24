import assert from "node:assert/strict";
import { test } from "node:test";

import { REQUIRED_RELEASE_SECTIONS, ensurePreparedReleaseNotes, validateReleaseNotes } from "../scripts/release-notes.mjs";

function notes(version: string): string {
  return [
    `## ${version}`,
    "",
    ...REQUIRED_RELEASE_SECTIONS.flatMap((section) => [`### ${section}`, "- None.", ""]),
  ].join("\n");
}

test("release notes require both the shipped and prepared versions", () => {
  assert.doesNotThrow(() => validateReleaseNotes(`${notes("0.2.39")}\n${notes("0.2.40")}`, "0.2.39", "0.2.40"));

  assert.throws(
    () => validateReleaseNotes(notes("0.2.39"), "0.2.39", "0.2.40"),
    /prepared entry for 0\.2\.40/,
  );
});

test("release notes require compatibility and safety metadata", () => {
  const incomplete = [
    "## 0.2.39",
    "### Material changes",
    "- Fixes.",
    "## 0.2.40",
    "### Material changes",
    "- Fixes.",
  ].join("\n");

  assert.throws(
    () => validateReleaseNotes(incomplete, "0.2.39", "0.2.40"),
    /missing sections: Compatibility\/configuration\/schema, Breaking\/behavior changes, Security\/safety, Upgrade guidance/,
  );
});

test("release notes can be prepared automatically with empty text", () => {
  const changelog = ["# Changelog", "", "## Unreleased", "", notes("0.2.39")].join("\n");
  const prepared = ensurePreparedReleaseNotes(changelog, "0.2.40");

  assert.equal(prepared.changed, true);
  assert.match(prepared.changelog, /## 0\.2\.40 - prepared release\n\n### Material changes/);
  assert.doesNotThrow(() => validateReleaseNotes(prepared.changelog, "0.2.39", "0.2.40"));
});

test("release notes can use supplied make argument text", () => {
  const changelog = ["# Changelog", "", "## Unreleased", "", notes("0.2.39")].join("\n");
  const prepared = ensurePreparedReleaseNotes(changelog, "0.2.40", "Ship the scheduler fixes.");

  assert.match(prepared.changelog, /## 0\.2\.40 - prepared release\n\nShip the scheduler fixes\.\n\n### Material changes/);
  assert.doesNotThrow(() => validateReleaseNotes(prepared.changelog, "0.2.39", "0.2.40"));
});

test("release notes completion preserves an existing prepared entry", () => {
  const changelog = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "## 0.2.40 - prepared release",
    "",
    "Already described.",
    "",
    "### Material changes",
    "- Fixes.",
    "",
    notes("0.2.39"),
  ].join("\n");
  const prepared = ensurePreparedReleaseNotes(changelog, "0.2.40", "Ignored replacement.");

  assert.equal((prepared.changelog.match(/Already described\./g) || []).length, 1);
  assert.doesNotMatch(prepared.changelog, /Ignored replacement/);
  assert.doesNotThrow(() => validateReleaseNotes(prepared.changelog, "0.2.39", "0.2.40"));
});

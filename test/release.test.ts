import assert from "node:assert/strict";
import { test } from "node:test";

import { REQUIRED_RELEASE_SECTIONS, validateReleaseNotes } from "../scripts/release-notes.mjs";

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

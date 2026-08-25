import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import { REQUIRED_RELEASE_SECTIONS, ensurePreparedReleaseNotes, validateReleaseNotes } from "../scripts/release-notes.mjs";
import { qualificationPlan, summarizeQualification, zeroCommandPlanSummary } from "../scripts/release-qualification.mjs";

const exec = promisify(execFile);

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

test("release qualification exposes a zero-token Tier 1 CI boundary", () => {
  const plan = zeroCommandPlanSummary("1");
  assert.ok(plan.some((group) => group.name === "Shared-kernel scenarios"));
  assert.ok(plan.some((group) => group.name === "Entry-point parity"));
  assert.ok(plan.some((group) => group.name === "Historical replay"));
  assert.ok(plan.some((group) => group.name === "Monitor idle/wake"));
  assert.equal(JSON.stringify(plan).includes("eval:lifecycle-canary"), false);
});

test("release qualification separates disposable consumer and credentialed canary tiers", () => {
  assert.deepEqual(qualificationPlan("2").groups.map((group) => group.name), ["Disposable consumer"]);
  assert.deepEqual(qualificationPlan("3").groups.map((group) => group.name), ["Pi canary"]);
  assert.equal((qualificationPlan("3").groups[0] as { requiresEnv?: string } | undefined)?.requiresEnv, "PI_NEXT_EVAL_ALLOW_LLM");
  const summary = summarizeQualification("0.2.84", "release", [{ name: "Monitor idle/wake", ok: true, passed: 1, total: 1, note: "(0 idle model calls)" }]);
  assert.match(summary, /pi-next 0\.2\.84 release qualification/);
  assert.match(summary, /Deterministic release gate qualified: YES/);
});

test("scripted lifecycle canary runs through the shared lifecycle boundary without credentials", async () => {
  const result = await exec(process.execPath, ["--import", "tsx", "scripts/eval-lifecycle-canary.ts", "--adapter", "scripted", "--smoke"], { encoding: "utf8" });
  const report = JSON.parse(result.stdout) as { passed: number; fixtureCount: number; lifecycleBoundary: string; adapter: { id: string } };
  assert.equal(report.adapter.id, "scripted");
  assert.equal(report.passed, report.fixtureCount);
  assert.match(report.lifecycleBoundary, /runSingleIssueLifecycle/);
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

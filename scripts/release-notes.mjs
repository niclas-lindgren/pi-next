export const REQUIRED_RELEASE_SECTIONS = [
  "Material changes",
  "Compatibility/configuration/schema",
  "Breaking/behavior changes",
  "Security/safety",
  "Upgrade guidance",
];

function versionPattern(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entryForVersion(changelog, version) {
  const heading = new RegExp(`^##[ \\t]+${versionPattern(version)}(?:[ \\t].*)?$`, "mi");
  const match = heading.exec(changelog);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const nextHeading = /^##\s+/m.exec(changelog.slice(start));
  const end = nextHeading ? start + nextHeading.index : changelog.length;
  return changelog.slice(start, end).trim();
}

function missingSections(entry) {
  return REQUIRED_RELEASE_SECTIONS.filter((section) => {
    const heading = new RegExp(`^###\\s+${versionPattern(section)}\\s*$`, "mi");
    return !heading.test(entry);
  });
}

/**
 * Validate the evidence that must already be present before release.mjs can
 * mutate package.json, create a tag, or push. A prepared next-version entry
 * keeps the release commit and its public notes inseparable.
 */
export function validateReleaseNotes(changelog, currentVersion, nextVersion) {
  const errors = [];
  const current = entryForVersion(changelog, currentVersion);
  const next = entryForVersion(changelog, nextVersion);

  if (!current) errors.push(`CHANGELOG.md has no entry for shipped version ${currentVersion}`);
  if (!next) errors.push(`CHANGELOG.md must contain a prepared entry for ${nextVersion} before releasing`);

  for (const [version, entry] of [[currentVersion, current], [nextVersion, next]]) {
    if (!entry) continue;
    const missing = missingSections(entry);
    if (missing.length) errors.push(`${version} release notes are missing sections: ${missing.join(", ")}`);
  }

  if (errors.length) {
    throw new Error(`Release evidence validation failed:\n- ${errors.join("\n- ")}`);
  }
  return { currentVersion, nextVersion };
}

export { entryForVersion };

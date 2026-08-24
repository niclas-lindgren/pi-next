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

function findEntry(changelog, version) {
  const heading = new RegExp(`^##[ \\t]+${versionPattern(version)}(?:[ \\t].*)?$`, "mi");
  const match = heading.exec(changelog);
  if (!match) return undefined;
  const contentStart = match.index + match[0].length;
  const nextHeading = /^##\s+/m.exec(changelog.slice(contentStart));
  const contentEnd = nextHeading ? contentStart + nextHeading.index : changelog.length;
  return {
    headingStart: match.index,
    headingEnd: contentStart,
    contentStart,
    contentEnd,
    entry: changelog.slice(contentStart, contentEnd).trim(),
  };
}

function entryForVersion(changelog, version) {
  return findEntry(changelog, version)?.entry;
}

function missingSections(entry) {
  return REQUIRED_RELEASE_SECTIONS.filter((section) => {
    const heading = new RegExp(`^###\\s+${versionPattern(section)}\\s*$`, "mi");
    return !heading.test(entry);
  });
}

function normalizeReleaseNotesText(notesText = "") {
  return String(notesText).replace(/\r\n?/g, "\n").trim();
}

function formatRequiredSections(sections = REQUIRED_RELEASE_SECTIONS) {
  return sections.map((section) => `### ${section}\n`).join("\n").trimEnd();
}

function formatReleaseEntry(version, notesText = "") {
  const notes = normalizeReleaseNotesText(notesText);
  const parts = [`## ${version} - prepared release`];
  if (notes) parts.push(notes);
  parts.push(formatRequiredSections());
  return `${parts.join("\n\n")}\n`;
}

function insertPreparedEntry(changelog, version, notesText) {
  const unreleased = findEntry(changelog, "Unreleased");
  const title = /^#\s+.*$/m.exec(changelog);
  const insertAt = unreleased?.contentEnd ?? (title ? title.index + title[0].length : 0);
  const entry = formatReleaseEntry(version, notesText);
  const before = changelog.slice(0, insertAt).trimEnd();
  const after = changelog.slice(insertAt).trimStart();
  return `${before}\n\n${entry}\n${after}`.trimEnd() + "\n";
}

function entryIntro(content) {
  const firstSection = /^###\s+/m.exec(content);
  return content.slice(0, firstSection?.index ?? content.length).trim();
}

/**
 * Ensure CHANGELOG.md contains a prepared release entry for the version that is
 * about to be tagged. When the entry is absent, it is inserted after
 * `## Unreleased` (or after the title in older changelog layouts) with the
 * required release-note section headings. A supplied notes string is used as the
 * entry's free-form introductory release-note text; an omitted string produces
 * an intentionally empty intro.
 */
export function ensurePreparedReleaseNotes(changelog, version, notesText = "") {
  const existing = findEntry(changelog, version);
  if (!existing) {
    return { changelog: insertPreparedEntry(changelog, version, notesText), changed: true };
  }

  let content = changelog.slice(existing.contentStart, existing.contentEnd);
  const notes = normalizeReleaseNotesText(notesText);
  if (notes && !entryIntro(content)) {
    content = `\n\n${notes}\n\n${content.trimStart()}`;
  }

  const missing = missingSections(content);
  if (missing.length) {
    content = `${content.trimEnd()}\n\n${formatRequiredSections(missing)}\n`;
  }

  if (content === changelog.slice(existing.contentStart, existing.contentEnd)) {
    return { changelog, changed: false };
  }
  return {
    changelog: `${changelog.slice(0, existing.contentStart)}${content}${changelog.slice(existing.contentEnd)}`,
    changed: true,
  };
}

/**
 * Validate the release evidence before release.mjs mutates package.json,
 * creates a tag, or pushes. A prepared next-version entry keeps the release
 * commit and its public notes inseparable.
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

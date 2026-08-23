import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SkillPackError,
  checkSkillPacks,
  resolveSkillPacks,
  syncSkillPacks,
} from "../src/skills/sync.ts";

const multiManifest = {
  schemaVersion: 1,
  sources: [
    {
      name: "mattpocock",
      upstream: {
        repository: "https://github.com/mattpocock/skills.git",
        revision: "0123456789012345678901234567890123456789",
        license: "LICENSE",
        provenance: "https://github.com/mattpocock/skills/commit/0123456789012345678901234567890123456789",
      },
      destination: "skills/vendor/mattpocock",
      packs: [{ name: "tdd", source: "packs/tdd", destination: "tdd", files: ["SKILL.md"] }],
      overlays: [],
    },
    {
      name: "superpowers",
      upstream: {
        repository: "https://github.com/example/superpowers.git",
        revision: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
        license: "LICENSE",
        provenance: "https://github.com/example/superpowers/commit/abcabcabcabcabcabcabcabcabcabcabcabcabca",
      },
      destination: "skills/vendor/superpowers",
      packs: [{ name: "verification", source: "packs/verification", destination: "verification", files: ["SKILL.md"] }],
      overlays: [{ name: "sp-overlay", path: "skills/overlays/sp.md", appliesTo: ["verification"] }],
    },
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-skills-multi-"));
  const matt = await mkdtemp(join(tmpdir(), "pi-next-matt-"));
  const sp = await mkdtemp(join(tmpdir(), "pi-next-sp-"));
  await mkdir(join(matt, "packs/tdd"), { recursive: true });
  await writeFile(join(matt, "LICENSE"), "MIT\n");
  await writeFile(join(matt, "packs/tdd/SKILL.md"), "# TDD\n");
  await mkdir(join(sp, "packs/verification"), { recursive: true });
  await writeFile(join(sp, "LICENSE"), "MIT\n");
  await writeFile(join(sp, "packs/verification/SKILL.md"), "# Verify\n");
  await mkdir(join(root, "skills/overlays"), { recursive: true });
  await writeFile(join(root, "skills/overlays/sp.md"), "overlay\n");
  await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(multiManifest, null, 2)}\n`);
  return { root, matt, sp };
}

async function cleanup(...paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

test("multiple pinned sources sync and check deterministically", async () => {
  const { root, matt, sp } = await fixture();
  try {
    const sourceDirs = { mattpocock: matt, superpowers: sp };
    const first = await syncSkillPacks({ root, sourceDirs });
    assert.equal(first.sources.length, 2);
    assert.deepEqual(first.sources.map((s) => s.name).sort(), ["mattpocock", "superpowers"]);

    const check = await checkSkillPacks({ root });
    assert.deepEqual(check.packs.sort(), ["tdd", "verification"]);
    assert.deepEqual(check.overlays, ["sp-overlay"]);
    assert.equal(check.sources.length, 2);

    const second = await syncSkillPacks({ root, sourceDirs });
    assert.deepEqual(second, first);

    const resolved = await resolveSkillPacks(root);
    assert.deepEqual(resolved.map((entry) => entry.name).sort(), ["tdd", "verification"]);
    const verification = resolved.find((entry) => entry.name === "verification");
    assert.equal(verification?.overlayPaths.length, 1);
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("per-source drift fails only that source and preserves consumer files", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    await writeFile(join(root, "skills/vendor/superpowers/verification/SKILL.md"), "tampered\n");
    await assert.rejects(
      () => checkSkillPacks({ root }),
      (error: unknown) => error instanceof SkillPackError && /drifted/.test(error.message),
    );
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("missing provenance for a synced source fails check", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    await rm(join(root, "skills/vendor/superpowers/PROVENANCE.json"));
    await assert.rejects(
      () => checkSkillPacks({ root }),
      (error: unknown) => error instanceof SkillPackError && /not synced/.test(error.message),
    );
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("overlapping source destinations and mixed manifest forms are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-skills-bad-"));
  try {
    await mkdir(join(root, "skills"), { recursive: true });
    const overlapping = structuredClone(multiManifest);
    overlapping.sources[1].destination = "skills/vendor/mattpocock/nested";
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(overlapping)}\n`);
    await assert.rejects(() => checkSkillPacks({ root }), (error: unknown) => error instanceof SkillPackError && /overlapping/.test(error.message));

    const mixed = { schemaVersion: 1, sources: multiManifest.sources, upstream: multiManifest.sources[0].upstream };
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(mixed)}\n`);
    await assert.rejects(() => checkSkillPacks({ root }), (error: unknown) => error instanceof SkillPackError && /either a single upstream source or a sources array/.test(error.message));
  } finally {
    await cleanup(root);
  }
});

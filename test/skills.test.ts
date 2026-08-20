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

const manifest = {
  schemaVersion: 1,
  upstream: {
    repository: "https://github.com/example/skills.git",
    revision: "0123456789012345678901234567890123456789",
    license: "LICENSE",
    provenance: "https://github.com/example/skills/commit/0123456789012345678901234567890123456789",
  },
  destination: "skills/vendor/example",
  packs: [
    {
      name: "review",
      source: "packs/review",
      destination: "review",
      files: ["SKILL.md", "notes.md"],
    },
  ],
  overlays: [{ name: "local-policy", path: "skills/overlays/local.md", appliesTo: ["review"] }],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-skills-test-"));
  const source = await mkdtemp(join(tmpdir(), "pi-next-skills-source-"));
  await mkdir(join(source, "packs/review"), { recursive: true });
  await writeFile(join(source, "LICENSE"), "MIT\n");
  await writeFile(join(source, "packs/review/SKILL.md"), "# Review\n\nRead [notes](notes.md).\n");
  await writeFile(join(source, "packs/review/notes.md"), "Companion\n");
  await mkdir(join(root, "skills/overlays"), { recursive: true });
  await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, "skills/overlays/local.md"), "Local adaptation\n");
  return { root, source };
}

async function cleanup(...paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

test("sync installs only the allowlist, records immutable provenance, and check is idempotent", async () => {
  const { root, source } = await fixture();
  try {
    const first = await syncSkillPacks({ root, sourceDir: source });
    const provenancePath = join(root, "skills/vendor/example/PROVENANCE.json");
    const before = await readFile(provenancePath, "utf8");
    assert.deepEqual(first.files, ["LICENSE", "review/SKILL.md", "review/notes.md"]);
    assert.deepEqual((await checkSkillPacks({ root })).packs, ["review"]);

    const second = await syncSkillPacks({ root, sourceDir: source });
    assert.deepEqual(second, first);
    assert.equal(await readFile(provenancePath, "utf8"), before);
    assert.equal(await readFile(join(root, "skills/overlays/local.md"), "utf8"), "Local adaptation\n");
    assert.deepEqual(await resolveSkillPacks(root), [{
      name: "review",
      skillPath: join(root, "skills/vendor/example/review/SKILL.md"),
      overlayPaths: [join(root, "skills/overlays/local.md")],
    }]);
  } finally {
    await cleanup(root, source);
  }
});

test("drift and consumer-owned destinations fail closed", async () => {
  const { root, source } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDir: source });
    await writeFile(join(root, "skills/vendor/example/review/SKILL.md"), "local edit\n");
    await assert.rejects(
      () => syncSkillPacks({ root, sourceDir: source }),
      (error: unknown) => error instanceof SkillPackError && /drifted/.test(error.message),
    );
    await assert.rejects(
      () => checkSkillPacks({ root }),
      (error: unknown) => error instanceof SkillPackError && /drifted/.test(error.message),
    );
  } finally {
    await cleanup(root, source);
  }

  const consumer = await mkdtemp(join(tmpdir(), "pi-next-skills-consumer-"));
  const consumerSource = await mkdtemp(join(tmpdir(), "pi-next-skills-consumer-source-"));
  try {
    await mkdir(join(consumer, "skills/vendor/example"), { recursive: true });
    await writeFile(join(consumer, "skills/vendor/example/consumer-skill.md"), "owned\n");
    await mkdir(join(consumerSource, "packs/review"), { recursive: true });
    await writeFile(join(consumerSource, "LICENSE"), "MIT\n");
    await writeFile(join(consumerSource, "packs/review/SKILL.md"), "# Review\n");
    await writeFile(join(consumerSource, "packs/review/notes.md"), "notes\n");
    await mkdir(join(consumer, "skills/overlays"), { recursive: true });
    await writeFile(join(consumer, "skills/overlays/local.md"), "overlay\n");
    await writeFile(join(consumer, "skills/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => syncSkillPacks({ root: consumer, sourceDir: consumerSource }),
      (error: unknown) => error instanceof SkillPackError && /consumer-owned/.test(error.message),
    );
    assert.equal(await readFile(join(consumer, "skills/vendor/example/consumer-skill.md"), "utf8"), "owned\n");
  } finally {
    await cleanup(consumer, consumerSource);
  }
});

test("missing referenced companions and unsafe manifest paths are rejected", async () => {
  const { root, source } = await fixture();
  try {
    await rm(join(source, "packs/review/notes.md"));
    await assert.rejects(() => syncSkillPacks({ root, sourceDir: source }), SkillPackError);
    const unsafe = { ...manifest, destination: "../consumer" };
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(unsafe)}\n`);
    await assert.rejects(() => checkSkillPacks({ root }), SkillPackError);
  } finally {
    await cleanup(root, source);
  }
});

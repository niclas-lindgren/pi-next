import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkSkillPacks, readSkillManifestSync, syncSkillPacks } from "../src/skills/sync.ts";
import {
  checkUnmanagedSkillDrift,
  loadEffectiveSkillRegistry,
} from "../src/skills/effective-registry.ts";
import { loadPiNextConfig } from "../src/coordination/config.ts";
import { resolveSkills, validateSkillRoutingPolicy, type SkillRoutingPolicy } from "../src/coordination/skill-registry.ts";
import { MATTPOCOCK_SKILLS_REVISION } from "../src/coordination/skill-compatibility.ts";
import { createWorkerDispatch } from "../src/coordination/worker-dispatch.ts";
import { buildPiNextPrompt } from "../extensions/pi-next/prompt.ts";

const REPO_ROOT = process.cwd();
const MATT_REV = "0123456789012345678901234567890123456789";
const SP_REV = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

const twoSourceManifest = {
  schemaVersion: 1,
  sources: [
    {
      name: "mattpocock",
      upstream: {
        repository: "https://github.com/mattpocock/skills.git",
        revision: MATT_REV,
        license: "LICENSE",
        provenance: `https://github.com/mattpocock/skills/commit/${MATT_REV}`,
      },
      destination: "skills/vendor/mattpocock",
      packs: ["code-review", "tdd", "diagnosing-bugs", "codebase-design"].map((name) => ({
        name,
        source: `packs/${name}`,
        destination: name,
        files: ["SKILL.md"],
      })),
      overlays: [],
    },
    {
      name: "superpowers",
      upstream: {
        repository: "https://github.com/example/superpowers.git",
        revision: SP_REV,
        license: "LICENSE",
        provenance: `https://github.com/example/superpowers/commit/${SP_REV}`,
      },
      destination: "skills/vendor/superpowers",
      packs: [{ name: "verification", source: "packs/verification", destination: "verification", files: ["SKILL.md"] }],
      overlays: [],
    },
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-next-effective-"));
  const matt = await mkdtemp(join(tmpdir(), "pi-next-effective-matt-"));
  const sp = await mkdtemp(join(tmpdir(), "pi-next-effective-sp-"));
  for (const name of ["code-review", "tdd", "diagnosing-bugs", "codebase-design"]) {
    await mkdir(join(matt, `packs/${name}`), { recursive: true });
    await writeFile(join(matt, `packs/${name}/SKILL.md`), `# ${name}\n\nmethodology body\n`);
  }
  await writeFile(join(matt, "LICENSE"), "MIT\n");
  await mkdir(join(sp, "packs/verification"), { recursive: true });
  await writeFile(join(sp, "packs/verification/SKILL.md"), "# Verify Before Completion\n\nRead the verification discipline.\n");
  await writeFile(join(sp, "LICENSE"), "MIT\n");
  await mkdir(join(root, "skills"), { recursive: true });
  await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(twoSourceManifest, null, 2)}\n`);
  return { root, matt, sp };
}

async function cleanup(...paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

function explicitConfig(skill: string): Record<string, unknown> {
  return {
    version: 1,
    authority: { adapter: "github", projectStatus: { todo: "Todo", inProgress: "In Progress", done: "Done", blocked: "Blocked" } },
    selection: { priorities: ["P0"], readyStates: ["ready"], blockedStates: ["blocked"] },
    repositoryPolicy: { entrypoints: [] },
    workflow: {
      stateDir: ".pi-next",
      planPath: ".pi-next/PLAN.md",
      verifyPath: ".pi-next/VERIFY.md",
      archiveDir: ".pi-next/ARCHIVED",
      deferredDir: ".pi-next/deferred",
      skillPath: ".pi-next/SKILL.md",
      tuningPath: ".pi-next/LOOP_TUNING.md",
      diagnosticsPath: ".pi-next/diagnostics",
      helperDir: ".pi-next/scripts",
    },
    skills: { version: 1, mandatory: [], automatic: [], explicit: [skill] },
  };
}

test("effective registry merges managed packs and package built-ins with manifest-derived provenance", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    const first = loadEffectiveSkillRegistry({ root });
    const second = loadEffectiveSkillRegistry({ root });
    assert.equal(first.registry.version, second.registry.version);

    const byId = new Map(first.entries.map((item) => [item.entry.id, item]));
    const tdd = byId.get("tdd")!;
    assert.equal(tdd.entry.provenanceVersion, `${MATT_REV}+pi-next-unattended-seam`);
    assert.equal(tdd.packageOwned, true);
    assert.equal(tdd.contentPath, join("skills", "pi-next", "tdd"));

    const spec = byId.get("code-review-spec")!;
    assert.equal(spec.entry.provenanceVersion, `${MATT_REV}+pi-next-role-spec`);
    assert.equal(spec.entry.source, "mattpocock");
    assert.equal(spec.contentPath, join("skills", "pi-next", "code-review-spec"));

    const bugs = byId.get("diagnosing-bugs")!;
    assert.equal(bugs.entry.provenanceVersion, MATT_REV);
    assert.equal(bugs.packageOwned, false);
    assert.equal(bugs.contentPath, join("skills", "vendor", "mattpocock", "diagnosing-bugs"));

    const review = byId.get("code-review")!;
    assert.equal(review.entry.processOwner, true);
    assert.equal(review.entry.provenanceVersion, MATT_REV);

    const verification = byId.get("verification")!;
    assert.equal(verification.entry.source, "superpowers");
    assert.equal(verification.entry.provenanceVersion, SP_REV);
    assert.equal(verification.entry.category, "verification");
    assert.equal(verification.entry.compatibility, undefined);
    assert.equal(verification.contentPath, join("skills", "vendor", "superpowers", "verification"));
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("second pinned source: config validates, dispatch selects exact provenance, only selected content loads", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    await mkdir(join(root, ".pi-next"), { recursive: true });
    await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(explicitConfig("verification")));

    // Config validation uses the effective registry, not only built-ins.
    const config = loadPiNextConfig(root);
    assert.deepEqual(config.skills.explicit, ["verification"]);

    // Dispatch selects the second-source skill with exact pinned provenance.
    const policy = createWorkerDispatch({
      phase: "implementation",
      requestedSkills: ["verification"],
      skillPolicy: config.skills,
      skillRegistry: loadEffectiveSkillRegistry({ root }).registry,
    });
    assert.deepEqual(policy.skills, ["verification"]);
    const selected = policy.skillSelection!.selected.find((skill) => skill.id === "verification")!;
    assert.equal(selected.source, "superpowers");
    assert.equal(selected.provenanceVersion, SP_REV);
    assert.equal(selected.tier, "explicit");

    // Only the selected content is loaded into the worker packet.
    const prompt = buildPiNextPrompt(root, "verify the candidate", undefined, { phase: "implementation", requestedSkills: ["verification"] });
    assert.match(prompt, /Selected skills: verification/);
    assert.match(prompt, /verification@superpowers:abcabcabcabcabcabcabcabcabcabcabcabcabca/);
    assert.match(prompt, /Read the verification discipline/);
    assert.doesNotMatch(prompt, /methodology body/);
    assert.doesNotMatch(prompt, /tdd \[package\]/);

    // An unclassified second-source skill cannot be routed automatically:
    // reviewed unattended compatibility metadata is required (issue #172).
    const automatic = structuredClone(explicitConfig("verification"));
    automatic.skills = { version: 1, mandatory: [], automatic: [{ skill: "verification", roles: ["implementation"] }], explicit: [] };
    await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(automatic));
    assert.throws(
      () => loadPiNextConfig(root),
      (error: unknown) => error instanceof Error && /lacks reviewed unattended compatibility metadata/.test(error.message),
    );
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("installed-but-unregistered content never enters the available registry", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    // A stray installed directory and a consumer-owned skill root: neither may
    // become part of the reviewed available catalog.
    await mkdir(join(root, "skills/vendor/unregistered/secret"), { recursive: true });
    await writeFile(join(root, "skills/vendor/unregistered/secret/SKILL.md"), "# secret\n");
    await mkdir(join(root, ".agents/skills/ask-matt"), { recursive: true });
    await writeFile(join(root, ".agents/skills/ask-matt/SKILL.md"), "# ask-matt\n");

    const registry = loadEffectiveSkillRegistry({ root }).registry;
    assert.ok(registry.entries.every((entry) => entry.id !== "secret" && entry.id !== "ask-matt"));

    const policy: SkillRoutingPolicy = { version: 1, mandatory: [], automatic: [], explicit: ["secret"] };
    assert.throws(
      () => validateSkillRoutingPolicy(policy, registry),
      (error: unknown) => error instanceof Error && /not present in the reviewed registry/.test(error.message),
    );
    assert.throws(
      () => validateSkillRoutingPolicy({ ...policy, explicit: ["ask-matt"] }, registry),
      (error: unknown) => error instanceof Error && /not present in the reviewed registry/.test(error.message),
    );
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("missing or drifted provenance fails closed through config and registry", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    await mkdir(join(root, ".pi-next"), { recursive: true });
    await writeFile(join(root, ".pi-next", "config.json"), JSON.stringify(explicitConfig("verification")));

    // Provenance drift: manifest pin changed without a resync.
    const drifted = structuredClone(twoSourceManifest);
    drifted.sources[1].upstream.revision = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(drifted)}\n`);
    assert.throws(() => loadEffectiveSkillRegistry({ root }), (error: unknown) => error instanceof Error && /manifest changed|does not match/.test(error.message));
    assert.throws(() => loadPiNextConfig(root), (error: unknown) => error instanceof Error && /effective skill registry/.test(error.message));

    // Restoring the reviewed pin makes the registry load again.
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(twoSourceManifest, null, 2)}\n`);
    assert.equal(loadEffectiveSkillRegistry({ root }).registry.version.length > 0, true);

    // Missing provenance for a declared source: fail closed.
    await rm(join(root, "skills/vendor/superpowers/PROVENANCE.json"));
    assert.throws(() => loadEffectiveSkillRegistry({ root }), (error: unknown) => error instanceof Error && /not synced/.test(error.message));
    assert.throws(() => loadPiNextConfig(root), (error: unknown) => error instanceof Error && /effective skill registry/.test(error.message));
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("duplicate managed skill ids across sources fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-effective-dup-"));
  const src = await mkdtemp(join(tmpdir(), "pi-next-effective-dup-src-"));
  try {
    const duplicateManifest = {
      schemaVersion: 1,
      sources: [{
        name: "mattpocock",
        upstream: {
          repository: "https://github.com/mattpocock/skills.git",
          revision: MATT_REV,
          license: "LICENSE",
          provenance: `https://github.com/mattpocock/skills/commit/${MATT_REV}`,
        },
        destination: "skills/vendor/mattpocock",
        packs: [
          { name: "tdd", source: "packs/a", destination: "tdd", files: ["SKILL.md"] },
          { name: "tdd", source: "packs/b", destination: "tdd-2", files: ["SKILL.md"] },
        ],
        overlays: [],
      }],
    };
    await mkdir(join(src, "packs/a"), { recursive: true });
    await writeFile(join(src, "packs/a/SKILL.md"), "# a\n");
    await mkdir(join(src, "packs/b"), { recursive: true });
    await writeFile(join(src, "packs/b/SKILL.md"), "# b\n");
    await writeFile(join(src, "LICENSE"), "MIT\n");
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills/manifest.json"), `${JSON.stringify(duplicateManifest)}\n`);
    await syncSkillPacks({ root, sourceDirs: { mattpocock: src } });
    assert.throws(() => loadEffectiveSkillRegistry({ root }), (error: unknown) => error instanceof Error && /duplicate managed skill id/.test(error.message));
  } finally {
    await cleanup(root, src);
  }
});

test("consumer-owned .agents/skills copies never route; drift from the managed allowlist fails check", async () => {
  const { root, matt, sp } = await fixture();
  try {
    await syncSkillPacks({ root, sourceDirs: { mattpocock: matt, superpowers: sp } });
    const manifest = readSkillManifestSync(root);
    await mkdir(join(root, ".agents/skills/tdd"), { recursive: true });
    const managedTdd = await readFile(join(root, "skills/vendor/mattpocock/tdd/SKILL.md"), "utf8");

    // Identical unmanaged copies are allowed (no independent drift).
    await writeFile(join(root, ".agents/skills/tdd/SKILL.md"), managedTdd);
    await checkUnmanagedSkillDrift({ root, manifest });

    // Independent drift fails the integrity gate.
    await writeFile(join(root, ".agents/skills/tdd/SKILL.md"), "# drifted copy\n");
    await assert.rejects(
      () => checkUnmanagedSkillDrift({ root, manifest }),
      (error: unknown) => error instanceof Error && /unmanaged duplicate of registered methodology "tdd".*drifted/.test(error.message),
    );
    await assert.rejects(() => checkSkillPacks({ root }), (error: unknown) => error instanceof Error && /drifted/.test(error.message));
  } finally {
    await cleanup(root, matt, sp);
  }
});

test("repo effective registry covers the reviewed built-ins and matches the shipped manifest pin", () => {
  const effective = loadEffectiveSkillRegistry({ root: REPO_ROOT });
  const byId = new Map(effective.registry.entries.map((entry) => [entry.id, entry]));
  for (const id of ["code-review", "code-review-spec", "code-review-standards", "tdd", "diagnosing-bugs", "codebase-design", "performance-telemetry", "verification-before-completion"]) {
    assert.ok(byId.has(id), `missing ${id}`);
  }
  // Provenance is derived from the shipped manifest, not the static fallback.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "skills/manifest.json"), "utf8")) as { upstream: { revision: string } };
  assert.equal(MATTPOCOCK_SKILLS_REVISION, manifest.upstream.revision);
  assert.ok(byId.get("tdd")!.provenanceVersion.startsWith(manifest.upstream.revision));
  assert.ok(byId.get("code-review-spec")!.provenanceVersion.startsWith(manifest.upstream.revision));
  // Consumer-owned .agents/skills content is never part of the available catalog.
  assert.ok(effective.registry.entries.every((entry) => entry.id !== "wizard" && entry.id !== "ask-matt" && entry.id !== "grilling"));
});

test("resolver stays adapter-neutral: same dispatch input through effective registry is deterministic", () => {
  const registry = loadEffectiveSkillRegistry({ root: REPO_ROOT }).registry;
  const policy: SkillRoutingPolicy = {
    version: 1,
    mandatory: [{ skill: "verification-before-completion", roles: ["verification"] }],
    automatic: [{ skill: "diagnosing-bugs", roles: ["repair"] }],
    explicit: ["codebase-design"],
  };
  const first = resolveSkills(registry, policy, { role: "repair", task: "fix regression" });
  const second = resolveSkills(registry, policy, { role: "repair", task: "fix regression" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.selected.map((skill) => skill.id), ["diagnosing-bugs"]);
});

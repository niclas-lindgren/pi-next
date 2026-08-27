/**
 * Effective runtime skill registry: the bridge between the reviewed managed
 * `skills/manifest.json` + per-source `PROVENANCE.json` (available catalog)
 * and the kernel's deterministic `SkillRegistry` used by config validation and
 * worker dispatch. Package-owned built-ins are always present; managed packs
 * from the checkout's manifest (or the shipped package manifest as a fallback)
 * derive their provenance revision from the manifest, never a static copy.
 *
 * Fail-closed boundaries: missing/drifted provenance, duplicate ids, and
 * duplicate categories are rejected. `.agents/skills/**` and any other
 * consumer-owned directories are never part of the available registry;
 * `checkUnmanagedSkillDrift` only fails when an unmanaged copy of a registered
 * methodology drifts from the managed allowlisted content.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";

import {
  buildSkillRegistry,
  type SkillRegistry,
  type SkillRegistryEntry,
} from "../coordination/skill-registry.ts";
import {
  BUILT_IN_SKILL_REGISTRY_ENTRIES,
  MATTPOCOCK_SKILLS_REVISION,
} from "../coordination/skill-compatibility.ts";
import {
  readSkillManifestSync,
  readSourceProvenanceSync,
  type SkillManifest,
  type SkillProvenance,
} from "./sync.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** One registry entry plus the reviewed content location used for lazy loading. */
export interface EffectiveRegistryEntry {
  entry: SkillRegistryEntry;
  /** Directory (relative to the checkout or package root) holding SKILL.md. */
  contentPath: string;
  /** Content ships with the package under `skills/pi-next/<id>`. */
  packageOwned: boolean;
}

export interface EffectiveRegistrySource {
  name: string;
  label: string;
  revision: string;
  destination: string;
}

export interface EffectiveSkillRegistry {
  registry: SkillRegistry;
  entries: EffectiveRegistryEntry[];
  sources: EffectiveRegistrySource[];
}

class EffectiveRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectiveRegistryError";
  }
}

function fail(message: string): never {
  throw new EffectiveRegistryError(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLabel(source: SkillManifest["sources"][number]): string {
  return source.name === "default" ? basename(source.destination) : source.name;
}

function provenanceSuffix(builtIn: SkillRegistryEntry): string {
  return builtIn.provenanceVersion.startsWith(MATTPOCOCK_SKILLS_REVISION)
    ? builtIn.provenanceVersion.slice(MATTPOCOCK_SKILLS_REVISION.length)
    : "";
}

/**
 * Deterministically merge managed packs and package-owned built-ins into one
 * effective registry. Provenance revisions come from the reviewed manifest.
 */
export function buildEffectiveSkillRegistry(
  manifest: SkillManifest,
  provenanceBySource: ReadonlyMap<string, SkillProvenance>,
): EffectiveSkillRegistry {
  const builtIns = new Map(BUILT_IN_SKILL_REGISTRY_ENTRIES.map((entry) => [entry.id, entry]));
  const managedPacks = new Map<string, { source: SkillManifest["sources"][number]; destination: string }>();
  const effective: EffectiveRegistryEntry[] = [];
  const sources: EffectiveRegistrySource[] = [];

  for (const source of manifest.sources) {
    const provenance = provenanceBySource.get(source.name);
    if (!provenance) fail(`managed source "${source.name}" has no reviewed provenance; run the deterministic sync`);
    if (provenance.manifest !== source.fingerprint) fail(`managed source "${source.name}" provenance drifted from the manifest; run the deterministic sync`);
    if (provenance.upstream.revision !== source.upstream.revision) fail(`managed source "${source.name}" provenance revision does not match the manifest`);
    sources.push({ name: source.name, label: sourceLabel(source), revision: source.upstream.revision, destination: source.destination });
    for (const pack of source.packs) {
      const id = pack.name;
      const destination = join(source.destination, pack.destination);
      if (managedPacks.has(id)) fail(`duplicate managed skill id across sources: ${id}`);
      managedPacks.set(id, { source, destination });
      const builtIn = builtIns.get(id);
      if (builtIn && builtIn.managedPack === id) {
        const entry: SkillRegistryEntry = {
          id,
          category: builtIn.category,
          source: sourceLabel(source),
          provenanceVersion: `${source.upstream.revision}${provenanceSuffix(builtIn)}`,
          ...(builtIn.capabilities?.length ? { capabilities: [...builtIn.capabilities] } : {}),
          ...(builtIn.processOwner ? { processOwner: true as const } : {}),
          ...(builtIn.compatibility ? { compatibility: builtIn.compatibility } : {}),
          packageOwned: builtIn.packageOwned === true,
          managedPack: id,
        };
        effective.push({
          entry,
          contentPath: builtIn.packageOwned ? join("skills", "pi-next", id) : destination,
          packageOwned: builtIn.packageOwned === true,
        });
      } else {
        // Reviewed managed pack without package-owned routing metadata:
        // available for explicit selection; automatic/mandatory routing fails
        // closed later because compatibility metadata is absent.
        effective.push({
          entry: { id, category: id, source: sourceLabel(source), provenanceVersion: source.upstream.revision, managedPack: id },
          contentPath: destination,
          packageOwned: false,
        });
      }
    }
  }

  // Package-owned built-ins not represented as a managed pack entry remain
  // available; managed-content built-ins whose own pack is absent are
  // unavailable (their reviewed content is not installed in this checkout).
  // Package-owned adapted disciplines derive their provenance from the
  // referenced managed pack when it is present.
  for (const builtIn of BUILT_IN_SKILL_REGISTRY_ENTRIES) {
    if (managedPacks.has(builtIn.id)) continue;
    if (builtIn.managedPack && !builtIn.packageOwned) continue;
    const base = builtIn.managedPack ? managedPacks.get(builtIn.managedPack) : undefined;
    const entry = base
      ? { ...builtIn, source: sourceLabel(base.source), provenanceVersion: `${base.source.upstream.revision}${provenanceSuffix(builtIn)}` }
      : builtIn;
    effective.push({
      entry,
      contentPath: join("skills", "pi-next", builtIn.id),
      packageOwned: true,
    });
  }

  const registry = buildSkillRegistry(effective.map((item) => item.entry));
  const byId = new Map(effective.map((item) => [item.entry.id, item]));
  return { registry, entries: registry.entries.map((entry) => byId.get(entry.id) ?? fail(`missing effective entry ${entry.id}`)), sources };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Load the effective registry for a checkout. The checkout's own
 * `skills/manifest.json` is authoritative when present; otherwise the shipped
 * package manifest supplies the package-owned reviewed catalog. Explicit
 * manifest/provenance inputs (tests) bypass filesystem reads. Synchronous so
 * config/prompt/dispatch paths share one deterministic registry.
 */
export function loadEffectiveSkillRegistry(options: {
  root?: string;
  manifest?: SkillManifest;
  provenance?: ReadonlyMap<string, SkillProvenance>;
} = {}): EffectiveSkillRegistry {
  if (options.manifest) {
    return buildEffectiveSkillRegistry(options.manifest, options.provenance ?? new Map());
  }
  const root = resolve(options.root ?? process.cwd());
  const manifestRoot = existsSync(join(root, "skills", "manifest.json")) ? root : PACKAGE_ROOT;
  const manifest = readSkillManifestSync(manifestRoot);
  const provenance = new Map<string, SkillProvenance>();
  for (const source of manifest.sources) {
    provenance.set(source.name, readSourceProvenanceSync(manifestRoot, source));
  }
  return buildEffectiveSkillRegistry(manifest, provenance);
}

/**
 * Integrity gate for `skills:check`: an unmanaged copy of a registered
 * methodology in the known consumer root `.agents/skills/<id>/SKILL.md` must
 * not drift from the managed allowlisted content. Identical copies are fine;
 * independent drift fails closed instead of being allowed to diverge silently.
 */
export async function checkUnmanagedSkillDrift(options: {
  root: string;
  manifest: SkillManifest;
}): Promise<void> {
  const root = resolve(options.root);
  const bases = new Map<string, string>();
  for (const source of options.manifest.sources) {
    for (const pack of source.packs) {
      bases.set(pack.name, join(source.destination, pack.destination, "SKILL.md"));
    }
  }
  for (const builtIn of BUILT_IN_SKILL_REGISTRY_ENTRIES) {
    if (builtIn.packageOwned && builtIn.managedPack && bases.has(builtIn.managedPack)) {
      bases.set(builtIn.id, bases.get(builtIn.managedPack)!);
    }
  }
  for (const [id, managedRelative] of bases) {
    const unmanaged = join(root, ".agents", "skills", id, "SKILL.md");
    if (!(await pathExists(unmanaged))) continue;
    const managed = join(root, managedRelative);
    if (!(await pathExists(managed))) continue;
    const managedText = await readFile(managed, "utf8");
    if (sha256(await readFile(unmanaged, "utf8")) !== sha256(managedText)) {
      fail(`unmanaged duplicate of registered methodology "${id}" drifted from the managed allowlisted content (${managedRelative}); consumer-owned copies must stay identical or be removed`);
    }
  }
}

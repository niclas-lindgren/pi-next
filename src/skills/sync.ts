import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const SKILL_MANIFEST_PATH = "skills/manifest.json";
const PROVENANCE_FILE = "PROVENANCE.json";
const MANIFEST_VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
/** Internal name for the classic single-upstream manifest form. */
const DEFAULT_SOURCE_NAME = "default";

export interface SkillPackManifest {
  name: string;
  source: string;
  destination: string;
  files: string[];
}

export interface SkillOverlayManifest {
  name: string;
  path: string;
  appliesTo: string[];
}

export interface SkillUpstream {
  repository: string;
  revision: string;
  license: string;
  provenance: string;
}

/** One reviewed, pinned upstream source installed into its own destination. */
export interface SkillSourceManifest {
  name: string;
  upstream: SkillUpstream;
  destination: string;
  packs: SkillPackManifest[];
  overlays: SkillOverlayManifest[];
  /** Deterministic per-source fingerprint recorded in that source's provenance. */
  fingerprint: string;
}

/** A registry manifest may pin one or more reviewed upstream sources. */
export interface SkillManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  sources: SkillSourceManifest[];
}

interface ProvenanceFile {
  path: string;
  sha256: string;
}

type ProvenancePack = Omit<SkillPackManifest, "files"> & { files: ProvenanceFile[] };

/** Durable per-source integrity record produced by the deterministic sync. */
export interface SkillProvenance {
  schemaVersion: typeof MANIFEST_VERSION;
  manifest: string;
  upstream: SkillUpstream;
  destination: string;
  packs: ProvenancePack[];
  license: ProvenanceFile;
  overlays: SkillOverlayManifest[];
}

export interface SkillSyncOptions {
  root: string;
  manifestPath?: string;
  /** Local checkout used for the single-source manifest form. */
  sourceDir?: string;
  /** Local checkouts keyed by source name for the multi-source form. */
  sourceDirs?: Record<string, string>;
}

export interface SkillSourceSyncResult {
  name: string;
  revision: string;
  destination: string;
  files: string[];
}

export interface SkillSyncResult {
  revision: string;
  files: string[];
  destination: string;
  sources: SkillSourceSyncResult[];
}

export interface SkillSourceCheckResult {
  name: string;
  revision: string;
  destination: string;
  packs: string[];
  files: number;
  overlays: string[];
}

export interface SkillCheckResult {
  revision: string;
  packs: string[];
  files: number;
  overlays: string[];
  sources: SkillSourceCheckResult[];
}

export class SkillPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPackError";
  }
}

function fail(message: string): never {
  throw new SkillPackError(message);
}

function safeRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || isAbsolute(value)) {
    fail(`${name} must be a non-empty relative path`);
  }
  const cleaned = normalize(value.trim()).replaceAll("\\", "/");
  if (cleaned === "." || cleaned.split("/").includes("..")) {
    fail(`${name} must stay inside the repository`);
  }
  return cleaned;
}

function safeName(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.trim())) {
    fail(`${name} must be a simple lower-case name`);
  }
  return value.trim();
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${name} must be a non-empty string array`);
  }
  return value.map((item) => String(item).trim());
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${name}.${key} is not supported`);
  }
}

function canonicalJson(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]));
    }
    return input;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateUpstream(raw: Record<string, unknown>, label: string): SkillUpstream {
  const upstream = object(raw.upstream, `${label}.upstream`);
  rejectUnknown(upstream, ["repository", "revision", "license", "provenance"], `${label}.upstream`);
  const repository = stringValue(upstream.repository, `${label}.upstream.repository`);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)) {
    fail(`${label}.upstream.repository must be an HTTPS GitHub .git URL`);
  }
  const revision = stringValue(upstream.revision, `${label}.upstream.revision`);
  if (!REVISION.test(revision)) fail(`${label}.upstream.revision must be a full 40-character commit SHA`);
  const license = safeRelativePath(upstream.license, `${label}.upstream.license`);
  const provenance = stringValue(upstream.provenance, `${label}.upstream.provenance`);
  if (!/^https:\/\//.test(provenance)) fail(`${label}.upstream.provenance must be an HTTPS URL`);
  return { repository, revision, license, provenance };
}

function validatePacks(rawPacks: unknown, label: string): SkillPackManifest[] {
  if (!Array.isArray(rawPacks) || rawPacks.length === 0) fail(`${label}.packs must be a non-empty array`);
  const destinations = new Set<string>();
  return rawPacks.map((raw, index) => {
    const pack = object(raw, `${label}.packs[${index}]`);
    rejectUnknown(pack, ["name", "source", "destination", "files"], `${label}.packs[${index}]`);
    const name = safeName(pack.name, `${label}.packs[${index}].name`);
    const source = safeRelativePath(pack.source, `${label}.packs[${index}].source`);
    const packDestination = safeRelativePath(pack.destination, `${label}.packs[${index}].destination`);
    const files = stringArray(pack.files, `${label}.packs[${index}].files`).map((file) => safeRelativePath(file, `${label}.packs[${index}].files[]`));
    if (!files.includes("SKILL.md")) fail(`${label}.packs[${index}] must allowlist SKILL.md`);
    for (const file of files) {
      const managed = `${packDestination}/${file}`;
      if (managed === "LICENSE" || managed === PROVENANCE_FILE) fail(`pack cannot manage reserved destination: ${managed}`);
      if (destinations.has(managed)) fail(`duplicate managed destination: ${managed}`);
      destinations.add(managed);
    }
    return { name, source, destination: packDestination, files };
  });
}

function validateOverlays(raw: unknown, label: string, destination: string, packs: SkillPackManifest[]): SkillOverlayManifest[] {
  const overlaysRaw = raw === undefined ? [] : raw;
  if (!Array.isArray(overlaysRaw)) fail(`${label}.overlays must be an array`);
  return overlaysRaw.map((entry, index) => {
    const overlay = object(entry, `${label}.overlays[${index}]`);
    rejectUnknown(overlay, ["name", "path", "appliesTo"], `${label}.overlays[${index}]`);
    const name = safeName(overlay.name, `${label}.overlays[${index}].name`);
    const path = safeRelativePath(overlay.path, `${label}.overlays[${index}].path`);
    const appliesTo = stringArray(overlay.appliesTo, `${label}.overlays[${index}].appliesTo`);
    if (appliesTo.some((pack) => !packs.some(({ name: known }) => known === pack))) {
      fail(`${label}.overlays[${index}].appliesTo references an unknown pack`);
    }
    if (path === destination || path.startsWith(`${destination}/`)) {
      fail(`${label}.overlays[${index}].path must not be inside the managed destination`);
    }
    return { name, path, appliesTo };
  });
}

function normalizeSingleSource(root: Record<string, unknown>): SkillSourceManifest {
  rejectUnknown(root, ["schemaVersion", "upstream", "destination", "packs", "overlays"], "manifest");
  const upstream = validateUpstream(root, "manifest");
  const destination = safeRelativePath(root.destination, "manifest.destination");
  const packs = validatePacks(root.packs, "manifest");
  const overlays = validateOverlays(root.overlays, "manifest", destination, packs);
  // Preserve the classic single-source fingerprint so existing provenance and
  // `skills:check` remain valid without a resync.
  const legacyFingerprint = fingerprint({ schemaVersion: MANIFEST_VERSION, upstream, destination, packs, overlays });
  return { name: DEFAULT_SOURCE_NAME, upstream, destination, packs, overlays, fingerprint: legacyFingerprint };
}

function normalizeMultiSource(root: Record<string, unknown>): SkillSourceManifest[] {
  rejectUnknown(root, ["schemaVersion", "sources"], "manifest");
  if (!Array.isArray(root.sources) || root.sources.length === 0) fail("manifest.sources must be a non-empty array");
  const names = new Set<string>();
  const destinations: string[] = [];
  return root.sources.map((raw, index) => {
    const label = `manifest.sources[${index}]`;
    const src = object(raw, label);
    rejectUnknown(src, ["name", "upstream", "destination", "packs", "overlays"], label);
    const name = safeName(src.name, `${label}.name`);
    if (names.has(name)) fail(`duplicate source name: ${name}`);
    names.add(name);
    const upstream = validateUpstream(src, label);
    const destination = safeRelativePath(src.destination, `${label}.destination`);
    for (const other of destinations) {
      if (destination === other || destination.startsWith(`${other}/`) || other.startsWith(`${destination}/`)) {
        fail(`overlapping source destination: ${destination}`);
      }
    }
    destinations.push(destination);
    const packs = validatePacks(src.packs, label);
    const overlays = validateOverlays(src.overlays, label, destination, packs);
    const sourceFingerprint = fingerprint({ name, upstream, destination, packs, overlays });
    return { name, upstream, destination, packs, overlays, fingerprint: sourceFingerprint };
  });
}

function validateManifest(value: unknown): SkillManifest {
  const root = object(value, "manifest");
  if (root.schemaVersion !== MANIFEST_VERSION) fail(`manifest.schemaVersion must be ${MANIFEST_VERSION}`);
  const hasSources = root.sources !== undefined;
  const hasSingle = root.upstream !== undefined || root.destination !== undefined || root.packs !== undefined || root.overlays !== undefined;
  if (hasSources && hasSingle) fail("manifest must use either a single upstream source or a sources array, not both");
  const sources = hasSources ? normalizeMultiSource(root) : [normalizeSingleSource(root)];
  return { schemaVersion: MANIFEST_VERSION, sources };
}

function rootPath(root: string, path: string): string {
  const base = resolve(root);
  const result = resolve(base, path);
  const rel = relative(base, result);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail(`path escapes repository: ${path}`);
  return result;
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

async function assertNoSymlinkPath(path: string, root: string): Promise<void> {
  const base = resolve(root);
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail(`path escapes repository: ${path}`);
  let current = base;
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    if (!(await pathExists(current))) continue;
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(`refusing to follow symlink: ${current}`);
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function provenanceFiles(provenance: SkillProvenance): ProvenanceFile[] {
  return [provenance.license, ...provenance.packs.flatMap((pack) => pack.files)];
}

function managedPath(destination: string, file: string): string {
  return join(destination, file);
}

async function assertCleanManagedFiles(destination: string, previous: SkillProvenance): Promise<void> {
  for (const file of provenanceFiles(previous)) {
    const managed = safeRelativePath(file.path, "provenance file path");
    if (!SHA256.test(file.sha256)) fail(`invalid hash in skill provenance: ${managed}`);
    const path = managedPath(destination, managed);
    if (!(await pathExists(path))) continue;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`managed path is not a regular file: ${file.path}`);
    if ((await sha256(path)) !== file.sha256) {
      fail(`managed file drifted; use an explicit overlay instead of editing ${file.path}`);
    }
  }
}

async function listFiles(path: string, prefix = ""): Promise<string[]> {
  if (!(await pathExists(path))) return [];
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) fail(`refusing to follow symlink: ${path}`);
  if (stat.isFile()) return [prefix];
  if (!stat.isDirectory()) fail(`managed path is not a regular file or directory: ${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    files.push(...(entry.isDirectory() ? await listFiles(child, childPrefix) : [childPrefix]));
  }
  return files.sort();
}

async function gitSource(repository: string, revision: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-next-skills-"));
  try {
    await execFile("git", ["init", "--quiet", directory]);
    await execFile("git", ["-C", directory, "remote", "add", "origin", repository]);
    await execFile("git", ["-C", directory, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", revision]);
    await execFile("git", ["-C", directory, "checkout", "--quiet", "--detach", revision]);
    const { stdout } = await execFile("git", ["-C", directory, "rev-parse", "HEAD"]);
    if (stdout.trim() !== revision) fail(`fetched revision does not match requested revision ${revision}`);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    fail(`unable to fetch pinned skill revision: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertRelativeLinks(root: string, pack: SkillPackManifest): Promise<void> {
  const allowed = new Set(pack.files);
  for (const file of pack.files.filter((candidate) => candidate.endsWith(".md"))) {
    const content = await readFile(join(root, pack.source, file), "utf8");
    const links = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].split("#", 1)[0]);
    for (const link of links) {
      if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) continue;
      const target = normalize(join(dirname(file), link)).replaceAll("\\", "/");
      if (target.split("/").includes("..") || !allowed.has(target)) {
        fail(`pack ${pack.name} references companion file not in its allowlist: ${file} -> ${link}`);
      }
    }
  }
}

export async function readSkillManifest(root: string, manifestPath = SKILL_MANIFEST_PATH): Promise<SkillManifest> {
  const path = rootPath(root, manifestPath);
  return validateManifest(await readJson(path));
}

/** Synchronous variant for sync runtime paths (config/prompt/dispatch). */
export function readSkillManifestSync(root: string, manifestPath = SKILL_MANIFEST_PATH): SkillManifest {
  const path = rootPath(root, manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(parsed);
}

/** Synchronous variant for sync runtime paths (config/prompt/dispatch). */
export function readSourceProvenanceSync(root: string, source: SkillSourceManifest): SkillProvenance {
  const markerPath = rootPath(root, join(source.destination, PROVENANCE_FILE));
  if (!existsSync(markerPath)) {
    fail(`managed skills are not synced; missing ${source.destination}/${PROVENANCE_FILE}`);
  }
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${markerPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(rawValue, "provenance");
  if (raw.schemaVersion !== MANIFEST_VERSION) fail("unsupported skill provenance schema");
  const provenance = raw as unknown as SkillProvenance;
  if (provenance.manifest !== source.fingerprint) fail("skill manifest changed; run the deterministic sync command");
  if (provenance.upstream.revision !== source.upstream.revision) fail("skill provenance revision does not match the manifest");
  return provenance;
}

async function buildProvenance(source: SkillSourceManifest, destination: string): Promise<SkillProvenance> {
  const packs: ProvenancePack[] = [];
  for (const pack of source.packs) {
    const files: ProvenanceFile[] = [];
    for (const file of pack.files) {
      files.push({ path: managedPath(pack.destination, file), sha256: await sha256(join(destination, pack.destination, file)) });
    }
    packs.push({ ...pack, files });
  }
  const licensePath = join(destination, "LICENSE");
  return {
    schemaVersion: MANIFEST_VERSION,
    manifest: source.fingerprint,
    upstream: source.upstream,
    destination: source.destination,
    packs,
    license: { path: "LICENSE", sha256: await sha256(licensePath) },
    overlays: source.overlays,
  };
}

function sourceCheckoutFor(options: SkillSyncOptions, manifest: SkillManifest, source: SkillSourceManifest): string | undefined {
  const named = options.sourceDirs?.[source.name];
  if (named) return named;
  if (options.sourceDir && manifest.sources.length === 1) return options.sourceDir;
  return undefined;
}

async function syncOneSource(root: string, source: SkillSourceManifest, sourceDirOverride?: string): Promise<SkillSourceSyncResult> {
  const destination = rootPath(root, source.destination);
  await assertNoSymlinkPath(destination, root);

  const markerPath = join(destination, PROVENANCE_FILE);
  await assertNoSymlinkPath(markerPath, destination);
  let previous: SkillProvenance | undefined;
  if (await pathExists(markerPath)) {
    const raw = object(await readJson(markerPath), "provenance");
    if (raw.schemaVersion !== MANIFEST_VERSION) fail("unsupported skill provenance schema");
    previous = raw as unknown as SkillProvenance;
    await assertCleanManagedFiles(destination, previous);
  } else if ((await listFiles(destination)).length > 0) {
    fail(`managed destination is not empty and has no ${PROVENANCE_FILE}; refusing to overwrite consumer-owned files`);
  }

  const checkout = sourceDirOverride ? resolve(sourceDirOverride) : await gitSource(source.upstream.repository, source.upstream.revision);
  try {
    const sourceLicense = rootPath(checkout, source.upstream.license);
    await assertNoSymlinkPath(sourceLicense, checkout);
    const sourceLicenseStat = await lstat(sourceLicense);
    if (!sourceLicenseStat.isFile() || sourceLicenseStat.isSymbolicLink()) fail("upstream license must be a regular file");
    for (const pack of source.packs) {
      const sourcePack = rootPath(checkout, pack.source);
      await assertNoSymlinkPath(sourcePack, checkout);
      for (const file of pack.files) {
        const sourcePath = join(sourcePack, file);
        const stat = await lstat(sourcePath).catch(() => undefined);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`allowlisted upstream file is missing or unsafe: ${pack.source}/${file}`);
      }
      await assertRelativeLinks(checkout, pack);
    }

    await mkdir(destination, { recursive: true });
    const destinationLicense = join(destination, "LICENSE");
    await assertNoSymlinkPath(destinationLicense, destination);
    await copyFile(sourceLicense, destinationLicense);
    const currentPaths = new Set<string>(["LICENSE", PROVENANCE_FILE]);
    for (const pack of source.packs) {
      for (const file of pack.files) {
        const output = managedPath(pack.destination, file);
        currentPaths.add(output);
        const sourcePath = join(checkout, pack.source, file);
        const destinationPath = join(destination, output);
        await assertNoSymlinkPath(destinationPath, destination);
        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
      }
    }

    if (previous) {
      for (const oldFile of provenanceFiles(previous)) {
        if (currentPaths.has(oldFile.path)) continue;
        const oldPath = join(destination, oldFile.path);
        if (await pathExists(oldPath)) await rm(oldPath);
      }
    }
    const provenance = await buildProvenance(source, destination);
    await writeFile(markerPath, canonicalJson(provenance), "utf8");
    return {
      name: source.name,
      revision: source.upstream.revision,
      destination: source.destination,
      files: [...currentPaths].filter((file) => file !== PROVENANCE_FILE).sort(),
    };
  } finally {
    if (!sourceDirOverride) await rm(checkout, { recursive: true, force: true });
  }
}

export async function syncSkillPacks(options: SkillSyncOptions): Promise<SkillSyncResult> {
  const root = resolve(options.root);
  const manifest = await readSkillManifest(root, options.manifestPath);
  const results: SkillSourceSyncResult[] = [];
  for (const source of manifest.sources) {
    results.push(await syncOneSource(root, source, sourceCheckoutFor(options, manifest, source)));
  }
  const primary = results[0];
  return { revision: primary.revision, files: primary.files, destination: primary.destination, sources: results };
}

async function checkOneSource(root: string, source: SkillSourceManifest): Promise<SkillSourceCheckResult> {
  const destination = rootPath(root, source.destination);
  const markerPath = join(destination, PROVENANCE_FILE);
  if (!(await pathExists(markerPath))) fail(`managed skills are not synced; missing ${source.destination}/${PROVENANCE_FILE}`);
  const provenance = object(await readJson(markerPath), "provenance") as unknown as SkillProvenance;
  if (provenance.manifest !== source.fingerprint) fail("skill manifest changed; run the deterministic sync command");
  if (provenance.upstream.revision !== source.upstream.revision) fail("skill provenance revision does not match the manifest");

  const expected = provenanceFiles(provenance);
  for (const file of expected) {
    const path = join(destination, file.path);
    if (!(await pathExists(path))) fail(`managed file is missing: ${file.path}`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`managed file is unsafe: ${file.path}`);
    if (!SHA256.test(file.sha256) || (await sha256(path)) !== file.sha256) fail(`managed file drifted: ${file.path}`);
  }
  const actual = new Set(await listFiles(destination));
  const expectedPaths = new Set(expected.map((file) => file.path).concat(PROVENANCE_FILE));
  for (const file of actual) if (!expectedPaths.has(file)) fail(`unexpected file in managed destination: ${file}`);

  for (const pack of source.packs) {
    const managedPack = join(destination, pack.destination);
    for (const file of pack.files.filter((candidate) => candidate.endsWith(".md"))) {
      const content = await readFile(join(managedPack, file), "utf8");
      for (const linkMatch of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = linkMatch[1].split("#", 1)[0];
        if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) continue;
        const target = normalize(join(dirname(file), link)).replaceAll("\\", "/");
        if (target.split("/").includes("..") || !pack.files.includes(target)) fail(`missing companion file: ${pack.name}/${target}`);
      }
    }
  }
  for (const overlay of source.overlays) {
    if (!(await pathExists(rootPath(root, overlay.path)))) fail(`local overlay is missing: ${overlay.path}`);
  }
  return {
    name: source.name,
    revision: source.upstream.revision,
    destination: source.destination,
    packs: source.packs.map((pack) => pack.name),
    files: expected.length,
    overlays: source.overlays.map((overlay) => overlay.name),
  };
}

export async function checkSkillPacks(options: SkillSyncOptions): Promise<SkillCheckResult> {
  const root = resolve(options.root);
  const manifest = await readSkillManifest(root, options.manifestPath);
  const results: SkillSourceCheckResult[] = [];
  for (const source of manifest.sources) results.push(await checkOneSource(root, source));
  // Integrity gate: an unmanaged copy of a registered methodology in a known
  // consumer skill root must not drift from the managed allowlisted content.
  // Loaded lazily to keep this module free of a static registry dependency.
  const { checkUnmanagedSkillDrift } = await import("./effective-registry.ts");
  await checkUnmanagedSkillDrift({ root, manifest });
  const primary = results[0];
  return {
    revision: primary.revision,
    packs: results.flatMap((result) => result.packs),
    files: results.reduce((total, result) => total + result.files, 0),
    overlays: results.flatMap((result) => result.overlays),
    sources: results,
  };
}

export async function resolveSkillPacks(root: string, manifestPath?: string): Promise<Array<{ name: string; skillPath: string; overlayPaths: string[] }>> {
  const base = resolve(root);
  const manifest = await readSkillManifest(base, manifestPath);
  return manifest.sources.flatMap((source) =>
    source.packs.map((pack) => ({
      name: pack.name,
      skillPath: rootPath(base, join(source.destination, pack.destination, "SKILL.md")),
      overlayPaths: source.overlays.filter((overlay) => overlay.appliesTo.includes(pack.name)).map((overlay) => rootPath(base, overlay.path)),
    })),
  );
}

export type SkillCliCommand = "sync" | "check";
export type SkillCliResult =
  | { ok: true; command: SkillCliCommand; result: SkillSyncResult | SkillCheckResult }
  | { ok: false; command: SkillCliCommand | "unknown"; code: "INVALID_ARGS" | "SKILL_ERROR"; message: string };

function parseCli(args: string[]): { command: SkillCliCommand; options: SkillSyncOptions } {
  const command = args.shift();
  if (command !== "sync" && command !== "check") fail(`unknown command: ${command ?? "(missing)"}`);
  const options: SkillSyncOptions = { root: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (flag === "--root") options.root = value ?? fail("--root requires a value");
    else if (flag === "--manifest") options.manifestPath = value ?? fail("--manifest requires a value");
    else if (flag === "--source-dir") options.sourceDir = value ?? fail("--source-dir requires a value");
    else fail(`unknown flag: ${flag}`);
  }
  return { command, options };
}

export async function runSkillsCli(args: string[]): Promise<SkillCliResult> {
  try {
    const { command, options } = parseCli([...args]);
    const result = command === "sync" ? await syncSkillPacks(options) : await checkSkillPacks(options);
    return { ok: true, command, result };
  } catch (error) {
    return {
      ok: false,
      command: args[0] === "sync" || args[0] === "check" ? args[0] : "unknown",
      code: error instanceof SkillPackError ? "SKILL_ERROR" : "INVALID_ARGS",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

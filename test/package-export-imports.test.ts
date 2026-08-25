import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["']((?:\.\.?\/)[^"']+)["']/g;

/**
 * `moduleResolution: "Bundler"` + `allowImportingTsExtensions` lets a ".js"
 * specifier resolve to a sibling ".ts" source file, which is how every
 * shipped module in this repo actually resolves at both dev time and for a
 * consumer typechecking against the installed package (no build step emits
 * real .js next to these .ts files).
 */
function resolveSpecifier(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${relative(packageRoot, fromFile)}: cannot resolve import "${specifier}"`);
}

function collectImportClosure(entryFiles: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const resolved = resolveSpecifier(file, match[1]!);
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

/**
 * #162's cross-repo fallout: `src/lifecycle/kernel.ts` (part of the public
 * "./lifecycle" export) imported `scripts/bootstrap-finalize.ts`, but
 * `scripts/` is dev-tooling excluded from package.json's `files` allowlist.
 * A consumer installing pi-next as a package got a `src/lifecycle` tree with
 * a dangling import and a broken typecheck. This walks every relative import
 * reachable from each public export entry point and proves the whole
 * closure is actually shipped, so this class of bug fails locally instead of
 * only in a downstream consumer's build.
 */
test("every relative import reachable from a package.json export ships in the published package", async () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  const entryFiles = Object.values(manifest.exports).map((entry) => resolve(packageRoot, entry));
  for (const entry of entryFiles) assert.ok(existsSync(entry), `export entry point missing: ${entry}`);

  const closure = collectImportClosure(entryFiles);

  const packed = JSON.parse((await exec("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot })).stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  const packedPaths = new Set(packed[0]!.files.map((file) => resolve(packageRoot, file.path)));

  const missing = [...closure].filter((file) => !packedPaths.has(file)).map((file) => relative(packageRoot, file));
  assert.deepEqual(missing, [], `imports reachable from a public export are not shipped: ${missing.join(", ")}`);
});

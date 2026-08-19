/** Runtime identity exposed by the doctor command and consumer smoke tests. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiNextRuntimeIdentity {
  version: string;
  revision: string;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim() ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function packageRevision(): string {
  const configured = process.env.PI_NEXT_REVISION?.trim();
  if (configured) return configured;
  try {
    return execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function piNextRuntimeIdentity(): PiNextRuntimeIdentity {
  return { version: packageVersion(), revision: packageRevision() };
}

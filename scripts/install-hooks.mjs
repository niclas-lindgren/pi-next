#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
console.log("Installed local hooks from .githooks/");

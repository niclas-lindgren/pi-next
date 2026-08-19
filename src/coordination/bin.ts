#!/usr/bin/env node
/**
 * Stable executable entrypoint for the shared issue coordination CLI.
 *
 *   pi-next-coordination <command> [flags]
 *
 * Commands: status, claim, renew, release, workspace, prepare, finalize.
 * See docs/ARCHITECTURE.md for the full command/flag/error-code contract.
 * This wrapper only parses argv, prints one JSON line to stdout, and sets
 * the process exit code (0 on success, 1 on a structured coordination
 * failure); all business logic lives in `cli.ts` so it stays independently
 * testable.
 */

import { runCoordinationCli } from "./cli.ts";

const result = await runCoordinationCli(process.argv.slice(2));
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

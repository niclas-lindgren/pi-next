// CLI entry point only. The finalize implementation lives in
// src/lifecycle/bootstrap-finalize.ts so it ships with the published package
// (scripts/ is dev-tooling-only and excluded from `files` in package.json)
// and remains importable by src/lifecycle/kernel.ts, a public "./lifecycle"
// export consumers depend on.
export * from "../src/lifecycle/bootstrap-finalize.ts";

import { BootstrapFinalizeError, runBootstrapFinalize } from "../src/lifecycle/bootstrap-finalize.ts";

function usage(): string { return `Usage: npm run bootstrap:finalize -- [--issue N]\n\nFinalize one mechanically-passing bootstrap candidate.\n\nOptions:\n  --issue N   finalize the explicit canonical agent/issue-N candidate\n  -h, --help  show this help\n`; }
function parseArgs(argv: string[]): { issueNumber?: number; help?: boolean } { const out: { issueNumber?: number; help?: boolean } = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === "--issue") { const value = argv[++i]; if (!value || !/^\d+$/.test(value)) throw new BootstrapFinalizeError("USAGE", "--issue requires a numeric issue number"); out.issueNumber = Number(value); } else if (arg === "--help" || arg === "-h") out.help = true; else throw new BootstrapFinalizeError("USAGE", `unknown argument: ${arg}`); } return out; }
export async function main(argv = process.argv.slice(2)): Promise<void> { const args = parseArgs(argv); if (args.help) { console.log(usage()); return; } const report = await runBootstrapFinalize({ issueNumber: args.issueNumber, reporter: (l) => console.log(l) }); console.log(JSON.stringify({ bootstrapFinalize: report })); }

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

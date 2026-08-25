#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TIER1_GROUPS = [
  { name: "Static contract", commands: [["node", ["scripts/check-file-size.mjs"]], ["npm", ["run", "typecheck"]]] },
  { name: "Shared-kernel scenarios", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/lifecycle-scenarios.test.ts", "test/lifecycle-kernel-parity.test.ts", "test/production-lifecycle.test.ts"]]] },
  { name: "Entry-point parity", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/lifecycle-kernel-parity.test.ts", "test/production-lifecycle.test.ts"]]] },
  { name: "Historical replay", commands: [["npm", ["run", "eval:replay", "--", "test/fixtures/replay/historical-incidents.json"]], ["node", ["scripts/run-tests-safe-git.mjs", "test/lifecycle-replay.test.ts"]]] },
  { name: "Fault/restart matrix", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/checkpoint.test.ts", "test/lifecycle-checkpoints.test.ts", "test/abandoned-recovery.test.ts", "test/workspace-recovery.test.ts", "test/workspace-cleanup.test.ts"]]] },
  { name: "Property/model seeds", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/lifecycle-model-property.test.ts"]]] },
  { name: "Scheduler continuation", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/auto-progress.test.ts", "test/scheduler-claim-race.test.ts", "test/production-lifecycle.test.ts"]]] },
  { name: "State/UI projection", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/auto-status.test.ts", "test/loop-status.test.ts", "test/production-lifecycle.test.ts"]]] },
  { name: "Monitor idle/wake", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/monitor.test.ts"]]] },
];

export const TIER2_GROUPS = [
  { name: "Disposable consumer", commands: [["node", ["scripts/run-tests-safe-git.mjs", "test/consumer-smoke.test.ts"]]] },
];

export const TIER3_GROUPS = [
  { name: "Pi canary", requiresEnv: "PI_NEXT_EVAL_ALLOW_LLM", commands: [["npm", ["run", "eval:lifecycle-canary", "--", "--adapter", "pi", "--smoke"]]] },
];

function manifestVersion() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export function qualificationPlan(tier) {
  if (tier === "1" || tier === "tier1") return { tier: "1", groups: TIER1_GROUPS };
  if (tier === "2" || tier === "tier2") return { tier: "2", groups: TIER2_GROUPS };
  if (tier === "3" || tier === "tier3") return { tier: "3", groups: TIER3_GROUPS };
  if (tier === "release") return { tier: "release", groups: [...TIER1_GROUPS, ...TIER2_GROUPS] };
  if (tier === "all") return { tier: "all", groups: [...TIER1_GROUPS, ...TIER2_GROUPS, ...TIER3_GROUPS] };
  throw new Error(`unknown qualification tier: ${tier}`);
}

function runCommand(command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  return { ok: !result.error && result.status === 0, status: result.status ?? null, signal: result.signal ?? null, error: result.error?.message, durationMs: Date.now() - started };
}

export function summarizeQualification(version, tier, results) {
  const lines = [`pi-next ${version} release qualification (${tier})`];
  for (const result of results) lines.push(`${result.name.padEnd(27)} ${result.ok ? "PASS" : "FAIL"} ${result.passed}/${result.total}${result.note ? ` ${result.note}` : ""}`);
  const failed = results.filter((result) => !result.ok).length;
  const label = tier === "all" ? "Production cutover qualified" : tier === "release" ? "Deterministic release gate qualified" : `Tier ${tier} qualified`;
  lines.push(`${label}: ${failed === 0 ? "YES" : "NO"}`);
  return lines.join("\n");
}

export function zeroCommandPlanSummary(tier = "1") {
  const plan = qualificationPlan(tier);
  return plan.groups.map((group) => ({ name: group.name, commands: group.commands.map(([cmd, args]) => [cmd, ...args].join(" ")) }));
}

export async function runQualification(tier) {
  const plan = qualificationPlan(tier);
  const results = [];
  for (const group of plan.groups) {
    if (group.requiresEnv && process.env[group.requiresEnv] !== "1") {
      results.push({ name: group.name, ok: false, passed: 0, total: 1, note: `(set ${group.requiresEnv}=1 for explicit credentialed run)` });
      continue;
    }
    let passed = 0;
    for (const [command, args] of group.commands) {
      const result = runCommand(command, args);
      if (result.ok) passed += 1;
      else console.error(`Qualification command failed in ${group.name}: ${command} ${args.join(" ")}`);
    }
    const note = group.name === "Monitor idle/wake" && passed === group.commands.length ? "(0 idle model calls)" : undefined;
    results.push({ name: group.name, ok: passed === group.commands.length, passed, total: group.commands.length, note });
  }
  console.log(summarizeQualification(manifestVersion(), plan.tier, results));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tierArg = process.argv.find((arg) => arg.startsWith("--tier="));
  const tier = tierArg?.slice("--tier=".length) ?? process.argv[2] ?? "1";
  runQualification(tier).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); });
}

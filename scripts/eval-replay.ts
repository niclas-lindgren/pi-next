#!/usr/bin/env node
import { resolve } from "node:path";

import { evaluateLifecycleReplaySuite } from "../src/evaluation/lifecycle-replay.ts";

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("Usage: npm run eval:replay -- <fixture.json>");
  process.exitCode = 2;
} else {
  try {
    const results = evaluateLifecycleReplaySuite(resolve(process.cwd(), fixturePath));
    const failures = results.filter((result) => !result.ok);
    console.log(JSON.stringify({
      fixture: fixturePath,
      cases: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      results: results.map((result) => ({
        name: result.name,
        ok: result.ok,
        nextAction: result.plan.nextAction,
        reason: result.plan.reason,
        mustNotRepeat: result.plan.mustNotRepeat,
        ...(result.error ? { error: result.error } : {}),
      })),
    }, null, 2));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

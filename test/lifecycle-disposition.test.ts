import assert from "node:assert/strict";
import { test } from "node:test";

import {
  lifecycleDispositionFromBootstrap,
  lifecycleDispositionFromVerificationFailure,
  lifecycleDispositionFromWorkerFailure,
  type LifecycleDisposition,
} from "../src/coordination/lifecycle-disposition.ts";

test("bootstrap dispositions map 1:1 with an optional reason", () => {
  assert.deepEqual(lifecycleDispositionFromBootstrap("pass"), { disposition: "pass", reason: undefined });
  assert.deepEqual(lifecycleDispositionFromBootstrap("already-satisfied"), { disposition: "already-satisfied", reason: undefined });
  assert.deepEqual(lifecycleDispositionFromBootstrap("no-change"), { disposition: "no-change", reason: undefined });
  assert.deepEqual(lifecycleDispositionFromBootstrap("repairable-failure", "npm test failed"), { disposition: "repairable-failure", reason: "npm test failed" });
  assert.deepEqual(lifecycleDispositionFromBootstrap("blocked", "foreign owner"), { disposition: "blocked", reason: "foreign owner" });
});

test("verification failure dispositions route to the matching outer disposition and retain the sub-classification", () => {
  const repair = lifecycleDispositionFromVerificationFailure("REPAIR", "criterion 2 failed");
  assert.equal(repair.disposition, "semantic-repair");
  assert.equal(repair.verificationFailureDisposition, "REPAIR");
  assert.equal(repair.reason, "criterion 2 failed");

  const defer = lifecycleDispositionFromVerificationFailure("DEFER_ISSUE");
  assert.equal(defer.disposition, "defer-issue");
  assert.equal(defer.verificationFailureDisposition, "DEFER_ISSUE");

  const reconcile = lifecycleDispositionFromVerificationFailure("RECONCILE");
  assert.equal(reconcile.disposition, "reconcile");
  assert.equal(reconcile.verificationFailureDisposition, "RECONCILE");
});

test("worker failure categories all route to worker-failed and retain the category", () => {
  for (const category of ["runtime", "repository", "work", "external", "transient"] as const) {
    const result = lifecycleDispositionFromWorkerFailure(category, `${category} failure`);
    assert.equal(result.disposition, "worker-failed");
    assert.equal(result.workerFailureCategory, category);
    assert.equal(result.reason, `${category} failure`);
  }
});

test("every LifecycleDisposition member is reachable from at least one translator", () => {
  const reachable = new Set<LifecycleDisposition>([
    lifecycleDispositionFromBootstrap("pass").disposition,
    lifecycleDispositionFromBootstrap("already-satisfied").disposition,
    lifecycleDispositionFromBootstrap("no-change").disposition,
    lifecycleDispositionFromBootstrap("repairable-failure").disposition,
    lifecycleDispositionFromBootstrap("blocked").disposition,
    lifecycleDispositionFromVerificationFailure("REPAIR").disposition,
    lifecycleDispositionFromVerificationFailure("DEFER_ISSUE").disposition,
    lifecycleDispositionFromVerificationFailure("RECONCILE").disposition,
    lifecycleDispositionFromWorkerFailure("runtime").disposition,
  ]);
  const expected: LifecycleDisposition[] = [
    "pass", "already-satisfied", "no-change", "repairable-failure",
    "semantic-repair", "defer-issue", "reconcile", "worker-failed", "blocked",
  ];
  for (const disposition of expected) assert.ok(reachable.has(disposition), `${disposition} is unreachable`);
  assert.equal(reachable.size, expected.length);
});

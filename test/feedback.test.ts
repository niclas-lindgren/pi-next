import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeedbackEvent,
  FeedbackReporter,
  feedbackFingerprint,
  sanitizeFeedbackText,
} from "../src/coordination/feedback.ts";

test("feedback sanitizes secrets and machine-specific details", () => {
  const text = sanitizeFeedbackText("token=ghp_1234567890 https://example.test/x /Users/alice/private");
  assert.doesNotMatch(text, /ghp_|example\.test|alice/);
  assert.match(text, /REDACTED|URL|PATH/);
});

test("equivalent failures have stable bounded fingerprints", () => {
  const a = feedbackFingerprint({ harness: "pi", stage: "claim", category: "transient", code: "busy", summary: "attempt 1" });
  const b = feedbackFingerprint({ harness: "pi", stage: "claim", category: "transient", code: "busy", summary: "attempt 2" });
  assert.equal(a, b);
});

test("recurring actionable failures escalate without issue storms", async () => {
  const published: unknown[] = [];
  const reporter = new FeedbackReporter({ publish: (event) => { published.push(event); } }, { recurringThreshold: 2, escalateCategories: ["runtime"], immediateSeverities: ["fatal"] });
  const make = () => createFeedbackEvent({ harness: "pi", stage: "worker", category: "runtime", severity: "error", outcome: "failed", code: "child_exit", summary: "worker failed", attempt: 1 });
  assert.equal((await reporter.report(make())).shouldEscalate, false);
  assert.equal((await reporter.report(make())).shouldEscalate, true);
  assert.equal(published.length, 1);
  assert.equal(reporter.events().length, 2);
});

test("fatal events escalate immediately and sink failure is contained", async () => {
  const reporter = new FeedbackReporter({ publish: () => { throw new Error("sink unavailable"); } });
  const result = await reporter.report(createFeedbackEvent({ harness: "pi", stage: "integrity", category: "integrity", severity: "fatal", outcome: "failed", code: "ownership", summary: "unsafe state", attempt: 1 }));
  assert.equal(result.shouldEscalate, true);
  assert.equal(result.sinkStatus, "failed");
});

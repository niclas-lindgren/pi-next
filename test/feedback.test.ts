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

test("feedback events are bounded, sanitized, and sink publication is deduplicated", async () => {
  const published: unknown[] = [];
  const reporter = new FeedbackReporter({ publish: (event) => { published.push(event); return { status: "pending" as const }; } }, { recurringThreshold: 1, escalateCategories: ["runtime"], immediateSeverities: [] });
  const event = createFeedbackEvent({
    harness: "pi",
    stage: "worker",
    category: "runtime",
    severity: "error",
    outcome: "failed",
    code: "child_exit",
    summary: "Bearer abcdefghijkl https://private.invalid /home/alice/project/file.ts:42",
    error: new Error("password=supersecret"),
    diagnosticRefs: ["https://private.invalid/once", "/tmp/private.log"],
    attempt: 1,
    at: "not-a-date",
  });
  assert.doesNotMatch(JSON.stringify(event), /supersecret|private\.invalid|alice|\/tmp/);
  assert.equal(event.version, 1);
  assert.equal(event.diagnosticRefs.length, 2);
  assert.equal((await reporter.report(event)).sinkStatus, "pending");
  assert.equal((await reporter.report(event)).sinkStatus, "suppressed");
  assert.equal(published.length, 1);
  assert.equal(reporter.recurrence(event.fingerprint), 2);
});

test("reentrant sinks are contained without recursive reporting", async () => {
  let reporter!: FeedbackReporter;
  let nested: Awaited<ReturnType<FeedbackReporter["report"]>> | undefined;
  reporter = new FeedbackReporter({
    publish: async (event) => { nested = await reporter.report(event); },
  }, { recurringThreshold: 1, escalateCategories: ["runtime"], immediateSeverities: [] });
  const result = await reporter.report(createFeedbackEvent({ harness: "pi", stage: "startup", category: "runtime", severity: "error", outcome: "failed", code: "startup", summary: "failed", attempt: 1 }));
  assert.equal(nested?.sinkStatus, "pending");
  assert.equal(result.sinkStatus, "published");
  assert.equal(reporter.events().length, 2);
});

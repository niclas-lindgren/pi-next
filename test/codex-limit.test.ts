import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCodexProbe, parseCodexLimitHeaders, probeCodexUsageLimit, type CodexUsageLimitProbe } from "../scripts/codex-limit.ts";

/** Captured live response headers from the Codex endpoint (2026-08-27, plan plus, primary window exhausted). */
function limitedHeaders(): Headers {
  const headers = new Headers();
  headers.set("x-codex-active-limit", "premium");
  headers.set("x-codex-plan-type", "plus");
  headers.set("x-codex-primary-used-percent", "100");
  headers.set("x-codex-secondary-used-percent", "58");
  headers.set("x-codex-primary-window-minutes", "300");
  headers.set("x-codex-primary-over-secondary-limit-percent", "0");
  headers.set("x-codex-secondary-window-minutes", "10080");
  headers.set("x-codex-primary-reset-after-seconds", "8071");
  headers.set("x-codex-secondary-reset-after-seconds", "456893");
  headers.set("x-codex-primary-reset-at", "1787825394");
  headers.set("x-codex-secondary-reset-at", "1788274216");
  return headers;
}

const FIXED_NOW = new Date("2026-08-27T07:55:00.000Z");

/** JWT-shaped token carrying the chatgpt_account_id claim, as `pi auth print-bearer-token` returns. */
function codexToken(accountId = "acct-123"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("parses a captured 429 usage-limit response into exact reset windows", () => {
  const probe = parseCodexLimitHeaders(429, limitedHeaders(), FIXED_NOW);
  assert.equal(probe.status, "limited");
  assert.equal(probe.httpStatus, 429);
  assert.equal(probe.planType, "plus");
  assert.equal(probe.primary.windowMinutes, 300);
  assert.equal(probe.primary.usedPercent, 100);
  assert.equal(probe.primary.resetsAtEpoch, 1787825394);
  assert.equal(probe.primary.resetsAtIso, "2026-08-27T10:09:54.000Z");
  assert.equal(probe.primary.resetsInSeconds, 8071);
  assert.equal(probe.secondary.resetsAtIso, "2026-09-01T14:50:16.000Z");
  assert.equal(probe.secondary.windowMinutes, 10080);
  assert.equal(probe.secondary.usedPercent, 58);
  assert.equal(probe.probedAt, FIXED_NOW.toISOString());
});

test("a 200 response is usable even when the error body is absent", () => {
  const probe = parseCodexLimitHeaders(200, limitedHeaders(), FIXED_NOW);
  assert.equal(probe.status, "usable");
  assert.equal(probe.message, undefined);
  assert.equal(probe.primary.resetsAtIso, "2026-08-27T10:09:54.000Z");
});

test("the error body fills reset fields the headers omit", () => {
  const headers = new Headers();
  headers.set("x-codex-plan-type", "plus");
  const probe = parseCodexLimitHeaders(429, headers, FIXED_NOW, {
    error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: 1787825394, resets_in_seconds: 8070 },
  });
  assert.equal(probe.status, "limited");
  assert.equal(probe.planType, "plus");
  assert.equal(probe.message, "The usage limit has been reached");
  assert.equal(probe.primary.resetsAtEpoch, 1787825394);
  assert.equal(probe.primary.resetsAtIso, "2026-08-27T10:09:54.000Z");
  assert.equal(probe.primary.resetsInSeconds, 8070);
});

test("probeCodexUsageLimit issues one minimal request and parses the response (injected fetch)", async () => {
  const limited = await probeCodexUsageLimit({
    token: codexToken(),
    fetchImpl: async () => new Response("", { status: 429, headers: limitedHeaders() }),
    now: () => FIXED_NOW,
  });
  assert.equal(limited.status, "limited");
  assert.equal(limited.primary.resetsAtIso, "2026-08-27T10:09:54.000Z");

  const usable = await probeCodexUsageLimit({
    token: codexToken(),
    fetchImpl: async () => new Response("", { status: 200, headers: new Headers() }),
    now: () => FIXED_NOW,
  });
  assert.equal(usable.status, "usable");
});

test("probe errors are typed, not thrown", async () => {
  const probe = await probeCodexUsageLimit({
    token: codexToken(),
    fetchImpl: async () => { throw new Error("network down"); },
    now: () => FIXED_NOW,
  });
  assert.equal(probe.status, "error");
  assert.equal(probe.message, "network down");
  assert.deepEqual(probe.primary, {});
  assert.deepEqual(probe.secondary, {});
});

test("non-JWT or account-less tokens fail closed with a typed probe error", async () => {
  const noJwt = await probeCodexUsageLimit({ token: "not-a-jwt" });
  assert.equal(noJwt.status, "error");
  assert.match(noJwt.message ?? "", /not a JWT/);
  const payload = Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url");
  const noAccount = await probeCodexUsageLimit({
    token: `header.${payload}.signature`,
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  assert.equal(noAccount.status, "error");
  assert.match(noAccount.message ?? "", /chatgpt_account_id/);
});

test("formatted output is stable and contains the reset windows", () => {
  const probe: CodexUsageLimitProbe = parseCodexLimitHeaders(429, limitedHeaders(), FIXED_NOW);
  const text = formatCodexProbe(probe);
  assert.match(text, /Codex usage-limit probe: limited \(HTTP 429\) · plan plus/);
  assert.match(text, /primary window:   300min · 100% used · resets 2026-08-27T10:09:54\.000Z/);
  assert.match(text, /LIMITED — re-run the credentialed eval after the primary window reset above/);
});

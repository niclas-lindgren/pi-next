#!/usr/bin/env tsx
/**
 * Deterministic Codex usage-limit probe (#172 evaluation tooling).
 *
 * When the openai-codex provider answers with a usage-limit error, this script
 * re-issues one minimal authenticated request to the Codex endpoint and prints
 * the exact primary/secondary rolling-window reset times from the response
 * headers, so nobody has to guess when the credentialed eval can be re-run.
 *
 *   npm run codex:limit             human-readable summary
 *   npm run codex:limit -- --json   machine-readable single JSON line
 *
 * Exit codes: 0 = usable, 1 = probe failed, 2 = usage limit active.
 * CI-safe: never runs during `npm test`; the pure header/body parser is
 * unit-tested with a captured fixture (see test/codex-limit.test.ts).
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export interface CodexLimitWindow {
  windowMinutes?: number;
  usedPercent?: number;
  resetsAtEpoch?: number;
  resetsAtIso?: string;
  resetsInSeconds?: number;
}

export interface CodexUsageLimitProbe {
  status: "usable" | "limited" | "error";
  httpStatus?: number;
  planType?: string;
  message?: string;
  primary: CodexLimitWindow;
  secondary: CodexLimitWindow;
  probedAt: string;
}

interface CodexErrorBody {
  error?: {
    type?: string;
    message?: string;
    plan_type?: string;
    resets_at?: number;
    resets_in_seconds?: number;
  };
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function windowFromHeaders(headers: Headers, primary: boolean): CodexLimitWindow {
  const prefix = primary ? "x-codex-primary-" : "x-codex-secondary-";
  const resetAt = headerNumber(headers, `${prefix}reset-at`);
  return {
    windowMinutes: headerNumber(headers, `${prefix}window-minutes`),
    usedPercent: headerNumber(headers, `${prefix}used-percent`),
    resetsAtEpoch: resetAt,
    resetsAtIso: resetAt !== undefined ? new Date(resetAt * 1000).toISOString() : undefined,
    resetsInSeconds: headerNumber(headers, `${prefix}reset-after-seconds`),
  };
}

function fillFromErrorBody(window: CodexLimitWindow, body: CodexErrorBody): CodexLimitWindow {
  const resetsAtEpoch = window.resetsAtEpoch ?? (typeof body.error?.resets_at === "number" ? body.error.resets_at : undefined);
  const resetsInSeconds = window.resetsInSeconds ?? (typeof body.error?.resets_in_seconds === "number" ? body.error.resets_in_seconds : undefined);
  return {
    ...window,
    ...(resetsAtEpoch !== undefined ? { resetsAtEpoch, resetsAtIso: new Date(resetsAtEpoch * 1000).toISOString() } : {}),
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
  };
}

/**
 * Pure parser over the Codex endpoint's response surface. `body` is optional
 * and only used as a fallback when the headers omit a reset field.
 */
export function parseCodexLimitHeaders(
  httpStatus: number,
  headers: Headers,
  probedAt = new Date(),
  body?: CodexErrorBody,
): CodexUsageLimitProbe {
  const planType = headers.get("x-codex-plan-type") ?? body?.error?.plan_type ?? undefined;
  const message = body?.error?.message ?? (httpStatus === 429 ? "usage limit reached" : undefined);
  return {
    status: httpStatus === 429 ? "limited" : "usable",
    httpStatus,
    planType,
    message,
    primary: fillFromErrorBody(windowFromHeaders(headers, true), body ?? {}),
    secondary: fillFromErrorBody(windowFromHeaders(headers, false), body ?? {}),
    probedAt: probedAt.toISOString(),
  };
}

async function bearerTokenFromPi(provider: string): Promise<string> {
  const { stdout } = await execFileAsync("pi", ["auth", "print-bearer-token", "--provider", provider], { encoding: "utf8", timeout: 15_000 });
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const token = lines.at(-1);
  if (!token) throw new Error(`pi auth print-bearer-token --provider ${provider} returned no token`);
  return token;
}

function accountIdFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("codex bearer token is not a JWT");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  const claims = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  const id = claims?.chatgpt_account_id;
  if (typeof id !== "string" || !id) throw new Error("codex bearer token has no chatgpt_account_id claim");
  return id;
}

/**
 * Deterministic probe: reads the pi OAuth bearer token for the openai-codex
 * provider, sends one minimal valid request, and returns the rate-limit
 * windows. Never reads the SSE stream on success (aborting right after the
 * headers keeps the probe effectively free), and only consumes the small
 * error body on HTTP 429.
 */
export async function probeCodexUsageLimit(options: {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = {}): Promise<CodexUsageLimitProbe> {
  const provider = options.provider ?? process.env.PI_NEXT_CODEX_PROVIDER ?? "openai-codex";
  const model = options.model ?? process.env.PI_NEXT_CODEX_MODEL ?? "gpt-5.5";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const probedAt = now();
  try {
    const token = options.token ?? (await bearerTokenFromPi(provider));
    const accountId = accountIdFromToken(token);
    const response = await fetchImpl(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions: "You are a helpful assistant.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
        text: { verbosity: "low" },
        tool_choice: "auto",
        parallel_tool_calls: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: CodexErrorBody | undefined;
    if (response.status === 429) {
      const text = await response.text().catch(() => "");
      if (text) {
        try { body = JSON.parse(text) as CodexErrorBody; } catch { body = undefined; }
      }
    } else {
      // Usable: the rate-limit headers are already sufficient; discard the
      // SSE stream immediately so the probe generates no output tokens.
      await response.body?.cancel();
    }
    return parseCodexLimitHeaders(response.status, response.headers, probedAt, body);
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      primary: {},
      secondary: {},
      probedAt: probedAt.toISOString(),
    };
  }
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 120) return `${Math.round((minutes / 60) * 10) / 10}h`;
  return `${minutes}m`;
}

export function formatCodexProbe(result: CodexUsageLimitProbe): string {
  const windowLine = (window: CodexLimitWindow) =>
    `${window.windowMinutes ?? "?"}min${window.usedPercent !== undefined ? ` · ${window.usedPercent}% used` : ""} · resets ${window.resetsAtIso ?? "unknown"} (${relativeTime(window.resetsAtIso)}${window.resetsInSeconds !== undefined ? `, ~${Math.round(window.resetsInSeconds / 60)}m` : ""})`;
  const lines = [
    `Codex usage-limit probe: ${result.status}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}${result.planType ? ` · plan ${result.planType}` : ""}`,
    ...(result.message ? [`  ${result.message}`] : []),
    `  primary window:   ${windowLine(result.primary)}`,
    `  secondary window: ${windowLine(result.secondary)}`,
  ];
  if (result.status === "limited") lines.push("LIMITED — re-run the credentialed eval after the primary window reset above");
  else if (result.status === "usable") lines.push("USABLE — the Codex limit is not currently active");
  else lines.push("PROBE FAILED — see message above");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const result = await probeCodexUsageLimit();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatCodexProbe(result));
  }
  return result.status === "limited" ? 2 : result.status === "usable" ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const DEFAULT_BASE_URLS = [
  "http://localhost:1234/v1",
  "http://host.lima.internal:1234/v1",
];
const DEFAULT_MAX_BYTES = 300_000;
const HARD_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function clampMaxBytes(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_MAX_BYTES;
  return Math.max(1_000, Math.min(Math.floor(parsed), HARD_MAX_BYTES));
}

function redactSensitive(text: string): string {
  return text
    .replace(
      /([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|KEY|AUTH|COOKIE|SESSION)[A-Z0-9_]*\s*[=:]\s*)[^\s'"`]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk|pk|rk|whsec|re)_(?:live|test)?_[A-Za-z0-9_\-]{12,}\b/g,
      "[REDACTED_API_KEY]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://[REDACTED]");
}

function readTail(
  path: string,
  maxBytes: number,
): { text: string; truncated: boolean; size: number } {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
  const size = stats.size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, size - length + offset);
      if (read === 0) break;
      offset += read;
    }
    return {
      text: redactSensitive(buffer.subarray(0, offset).toString("utf8")),
      truncated: length < size,
      size,
    };
  } finally {
    closeSync(fd);
  }
}

function configuredBaseUrls(): string[] {
  const configured = process.env.LOCAL_LLM_BASE_URL;
  const raw = configured ? configured.split(",") : DEFAULT_BASE_URLS;
  return raw
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

async function callLocalLlm(system: string, user: string): Promise<string> {
  const model =
    process.env.LOCAL_LLM_MODEL ||
    process.env.LM_STUDIO_MODEL ||
    "local-model";
  const errors: string[] = [];

  for (const baseUrl of configuredBaseUrls()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 1_400,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Local LLM returned no message content");
      return content;
    } catch (error) {
      errors.push(
        `${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Local LLM request failed for all configured endpoints: ${errors.join("; ")}`,
  );
}

const SYSTEM_PROMPTS = {
  text: "Compress technical text for a coding agent. Preserve exact filenames, commands, error names, and line numbers. Be concise and do not invent facts.",
  log: "Summarize CI/test/build logs tersely and factually. Return status, primary failures, likely cause, and at most three next commands. Mention truncation and do not invent facts.",
  failures: "Extract only actionable failures from logs. Group by failing test, file, or error. Ignore progress output, repeated stack frames, and successful output. Do not invent facts.",
} as const;

export default function localLlmTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "local_summarize",
    label: "Local Summarize",
    description:
      "Use the configured local model to compress text or summarize a bounded log tail.",
    parameters: Type.Union([
      Type.Object({
        mode: Type.Literal("text"),
        text: Type.String(),
        focus: Type.Optional(Type.String()),
      }),
      Type.Object({
        mode: Type.Union([Type.Literal("log"), Type.Literal("failures")]),
        path: Type.String(),
        maxBytes: Type.Optional(Type.Number()),
        focus: Type.Optional(Type.String()),
      }),
    ]),
    async execute(_toolCallId, params) {
      let input: string;
      let details: Record<string, unknown>;

      if (params.mode === "text") {
        if (!params.text.trim()) throw new Error("text cannot be empty");
        input = redactSensitive(params.text).slice(0, HARD_MAX_BYTES);
        details = { inputChars: input.length };
      } else {
        if (!params.path.trim()) throw new Error("path cannot be empty");
        const maxBytes = clampMaxBytes(params.maxBytes);
        const result = readTail(params.path, maxBytes);
        input = [
          `Path: ${params.path}`,
          `Size: ${result.size} bytes`,
          `Tail truncated: ${result.truncated}`,
          "",
          result.text,
        ].join("\n");
        details = {
          path: params.path,
          size: result.size,
          maxBytes,
          truncated: result.truncated,
        };
      }

      const focus = params.focus?.trim()
        ? `Focus: ${params.focus.trim()}\n\n`
        : "";
      const summary = await callLocalLlm(
        SYSTEM_PROMPTS[params.mode],
        `${focus}${input}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `[local-llm ${params.mode}; verify before acting]\n${summary}`,
          },
        ],
        details: { ...details, mode: params.mode },
      };
    },
  });

  pi.registerCommand("local-llm-status", {
    description: "Check configured local LLM endpoints",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      for (const baseUrl of configuredBaseUrls()) {
        try {
          const response = await fetch(`${baseUrl}/models`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          results.push(`✓ ${baseUrl}`);
        } catch (error) {
          results.push(
            `✗ ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const reachable = results.some((line) => line.startsWith("✓"));
      ctx.ui.notify(
        `Local LLM endpoints:\n${results.join("\n")}`,
        reachable ? "info" : "warning",
      );
    },
  });
}

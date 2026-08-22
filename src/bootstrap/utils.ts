import { BootstrapProgressEvent, BootstrapReporter, MAX_OUTPUT } from "./types.js";

export function bounded(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED_API_KEY]");
}

export function redact(value: string): string {
  return bounded(redactSecrets(value));
}

export function emitProgress(reporter: BootstrapReporter | undefined, event: BootstrapProgressEvent): void {
  try {
    reporter?.(event);
  } catch {
    // Operator feedback must never alter lifecycle semantics.
  }
}

export function progressToolName(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; toolName?: unknown };
  return item.type === "tool_execution_end" && typeof item.toolName === "string" ? item.toolName.slice(0, 80) : undefined;
}

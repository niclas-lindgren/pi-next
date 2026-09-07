import { BootstrapProgressEvent, BootstrapReporter } from "./types.js";

function progressDuration(elapsedMs: number): string {
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${Math.round(elapsedMs / 1_000)}s`;
}

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(Math.round(value));
}

function usageText(event: BootstrapProgressEvent): string | undefined {
  const usage = event.usage;
  if (!usage) return undefined;
  const fresh = (usage.input || 0) + (usage.output || 0);
  const cache = usage.cacheRead || 0;
  return `tokens=${compactTokens(usage.total || fresh + cache)} (fresh=${compactTokens(fresh)} cache=${compactTokens(cache)} out=${compactTokens(usage.output || 0)})`;
}

export function formatBootstrapProgress(event: BootstrapProgressEvent): string {
  const phase = event.phase === "check" ? "verification" : event.phase;
  const parts = [`bootstrap #${event.issueNumber}`, phase];
  if (event.role) parts.push(event.role);
  if (event.command) parts.push(event.command);
  if (event.tool) parts.push(`tool=${event.tool}`);
  parts.push(event.state.toUpperCase());
  if (event.model) parts.push(`model=${event.model}`);
  if (event.toolCalls !== undefined) parts.push(`calls=${event.toolCalls}`);
  if (event.modelRounds !== undefined) parts.push(`rounds=${event.modelRounds}`);
  const usage = usageText(event);
  if (usage) parts.push(usage);
  if (event.elapsedMs !== undefined) parts.push(`elapsed=${progressDuration(event.elapsedMs)}`);
  if (event.detail) parts.push(event.detail.slice(0, 200));
  return parts.join(" · ");
}

export function createCliProgressReporter(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): BootstrapReporter {
  return (event) => write(formatBootstrapProgress(event));
}

import { BootstrapProgressEvent, BootstrapReporter } from "./types.js";

function progressDuration(elapsedMs: number): string {
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${Math.round(elapsedMs / 1_000)}s`;
}

export function formatBootstrapProgress(event: BootstrapProgressEvent): string {
  const parts = [`bootstrap #${event.issueNumber}`, event.phase];
  if (event.role) parts.push(event.role);
  if (event.command) parts.push(event.command);
  if (event.tool) parts.push(`tool=${event.tool}`);
  parts.push(event.state.toUpperCase());
  if (event.model) parts.push(`model=${event.model}`);
  if (event.toolCalls !== undefined) parts.push(`calls=${event.toolCalls}`);
  if (event.elapsedMs !== undefined) parts.push(`elapsed=${progressDuration(event.elapsedMs)}`);
  if (event.detail) parts.push(event.detail.slice(0, 200));
  return parts.join(" · ");
}

export function createCliProgressReporter(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): BootstrapReporter {
  return (event) => write(formatBootstrapProgress(event));
}

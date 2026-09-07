import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatBootstrapProgress } from "../../src/bootstrap/reporter.ts";
import type { BootstrapProgressEvent } from "../../src/bootstrap/types.ts";
import type { LifecycleReporter } from "../../src/lifecycle/index.ts";
import type { LifecycleSchedulerResult, UnifiedLifecycleResult } from "../../src/lifecycle/index.ts";
import { safeNotify } from "./util.ts";

const AUTO_START_SYMBOL = Symbol.for("pi-next.auto.start-emitted");

type MarkedContext = ExtensionCommandContext & { [AUTO_START_SYMBOL]?: boolean };

function bounded(value: string, max = 220): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function issuePrefix(issueNumber: number): string {
  return issueNumber > 0 ? `#${issueNumber}` : "Pi-next auto";
}

function autoState(state: BootstrapProgressEvent["state"]): string {
  return state.toUpperCase();
}

export function markAutoStartEmitted(ctx: ExtensionCommandContext): void {
  (ctx as MarkedContext)[AUTO_START_SYMBOL] = true;
}

export function hasAutoStartEmitted(ctx: ExtensionCommandContext): boolean {
  return Boolean((ctx as MarkedContext)[AUTO_START_SYMBOL]);
}

export function emitAutoStart(ctx: ExtensionCommandContext, detail?: string): void {
  if (!hasAutoStartEmitted(ctx)) markAutoStartEmitted(ctx);
  safeNotify(ctx, `Pi-next auto · START${detail ? ` · ${bounded(detail, 120)}` : ""}`, "info");
}

export function formatPiLifecycleProgress(event: BootstrapProgressEvent & { entry?: string }): string {
  if (event.phase === "scheduler") {
    const detail = event.detail ? bounded(event.detail) : event.state === "start" ? "selecting work" : "";
    if (event.issueNumber > 0 && detail.startsWith("selected")) return `selected #${event.issueNumber}`;
    return [`Pi-next auto`, detail || autoState(event.state)].filter(Boolean).join(" · ");
  }
  if (event.phase === "claim") {
    return `${issuePrefix(event.issueNumber)} · claim · ${autoState(event.state)}${event.detail ? ` · ${bounded(event.detail)}` : ""}`;
  }
  const bootstrap = formatBootstrapProgress(event).replace(/^bootstrap #/, "#").replace(" · check · ", " · verification · ");
  return bootstrap;
}

export function createPiLifecycleReporter(ctx: ExtensionCommandContext): LifecycleReporter {
  return (event) => {
    safeNotify(ctx, formatPiLifecycleProgress(event), event.state === "fail" || event.state === "blocked" ? "warning" : "info");
  };
}

function usageSummary(results: readonly UnifiedLifecycleResult[]): string | undefined {
  let launches = 0;
  let calls = 0;
  let rounds = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let total = 0;
  let warnings: string[] = [];
  for (const result of results) {
    for (const worker of result.implementationReport.workerAttempts) {
      launches += 1;
      calls += worker.toolCalls || 0;
      rounds += worker.modelRounds || 0;
      input += worker.usage?.input || 0;
      output += worker.usage?.output || 0;
      cacheRead += worker.usage?.cacheRead || 0;
      total += worker.usage?.total || 0;
      if (worker.telemetryWarning) warnings.push(worker.telemetryWarning);
    }
  }
  if (!launches && !total && !calls) return undefined;
  const tokenPart = total ? `tokens=${total} input=${input} output=${output} cache-read=${cacheRead}` : "tokens=unavailable";
  return `workers=${launches} rounds=${rounds} calls=${calls} ${tokenPart}${warnings.length ? ` warnings=${bounded(warnings.join("; "), 100)}` : ""}`;
}

export function formatAutoTerminalSummary(result: LifecycleSchedulerResult, requestedIssues: number): string {
  const settled = `${result.settled}/${requestedIssues} settled`;
  const latest = result.latest;
  const usage = usageSummary(result.results);
  const suffix = usage ? ` · ${usage}` : "";
  switch (result.disposition) {
    case "idle":
      return `Pi-next auto · IDLE · no eligible issues${suffix}`;
    case "completed":
      return `Pi-next auto · COMPLETED · ${settled}${suffix}`;
    case "cancelled":
      return `Pi-next auto · CANCELLED · stopped by operator · ${settled}${suffix}`;
    case "budget-yield":
      return `Pi-next auto · BUDGET YIELD · ${settled}${suffix}`;
    case "blocked": {
      if (latest?.finalization === "BLOCKED") {
        return `Pi-next auto · BLOCKED · #${latest.issueNumber} finalization blocked; candidate preserved${suffix}`;
      }
      return `Pi-next auto · BLOCKED · ${latest ? `#${latest.issueNumber} ${latest.disposition}` : "scheduler blocked"} · ${settled}${suffix}`;
    }
  }
}

export function formatAutoFailedSummary(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Pi-next auto · FAILED · scheduler/authority failure: ${bounded(reason)}`;
}

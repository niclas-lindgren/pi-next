import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { prunePiNextContext } from "./context-pruning-core.mjs";
import { planFile, runtimeDir, writeJsonAtomic } from "./util.ts";

export { prunePiNextContext } from "./context-pruning-core.mjs";

const CONTEXT_TELEMETRY_FILE = "pi-next-context.json";

interface ContextPruneStats {
  messagesBefore: number;
  messagesAfter: number;
  prunedToolResults: number;
  charsBefore: number;
  charsAfter: number;
  charsPruned: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesPruned: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensPruned: number;
}

interface ContextTelemetryState {
  version: 1;
  updatedAt: string;
  modelContextCalls: number;
  pruneEvents: number;
  prunedToolResults: number;
  cumulativeCharsBefore: number;
  cumulativeCharsAfter: number;
  cumulativeCharsPruned: number;
  cumulativeBytesBefore: number;
  cumulativeBytesAfter: number;
  cumulativeBytesPruned: number;
  cumulativeEstimatedTokensBefore: number;
  cumulativeEstimatedTokensAfter: number;
  cumulativeEstimatedTokensPruned: number;
  compactionEvents: number;
  recoveryRefetchEvents: number;
  lastObservation?: ContextPruneStats & { observedAt: string };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function telemetryPath(cwd: string): string {
  return join(runtimeDir(cwd), CONTEXT_TELEMETRY_FILE);
}

function emptyTelemetry(): ContextTelemetryState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    modelContextCalls: 0,
    pruneEvents: 0,
    prunedToolResults: 0,
    cumulativeCharsBefore: 0,
    cumulativeCharsAfter: 0,
    cumulativeCharsPruned: 0,
    cumulativeBytesBefore: 0,
    cumulativeBytesAfter: 0,
    cumulativeBytesPruned: 0,
    cumulativeEstimatedTokensBefore: 0,
    cumulativeEstimatedTokensAfter: 0,
    cumulativeEstimatedTokensPruned: 0,
    compactionEvents: 0,
    recoveryRefetchEvents: 0,
  };
}

function readTelemetry(cwd: string): ContextTelemetryState {
  const path = telemetryPath(cwd);
  if (!existsSync(path)) return emptyTelemetry();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ContextTelemetryState>;
    return {
      ...emptyTelemetry(),
      ...value,
      version: 1,
      modelContextCalls: finite(value.modelContextCalls),
      pruneEvents: finite(value.pruneEvents),
      prunedToolResults: finite(value.prunedToolResults),
      cumulativeCharsBefore: finite(value.cumulativeCharsBefore),
      cumulativeCharsAfter: finite(value.cumulativeCharsAfter),
      cumulativeCharsPruned: finite(value.cumulativeCharsPruned),
      cumulativeBytesBefore: finite(value.cumulativeBytesBefore),
      cumulativeBytesAfter: finite(value.cumulativeBytesAfter),
      cumulativeBytesPruned: finite(value.cumulativeBytesPruned),
      cumulativeEstimatedTokensBefore: finite(value.cumulativeEstimatedTokensBefore),
      cumulativeEstimatedTokensAfter: finite(value.cumulativeEstimatedTokensAfter),
      cumulativeEstimatedTokensPruned: finite(value.cumulativeEstimatedTokensPruned),
      compactionEvents: finite(value.compactionEvents),
      recoveryRefetchEvents: finite(value.recoveryRefetchEvents),
    };
  } catch {
    return emptyTelemetry();
  }
}

function writeTelemetry(cwd: string, state: ContextTelemetryState): void {
  writeJsonAtomic(telemetryPath(cwd), state);
}

function recordObservation(cwd: string, stats: ContextPruneStats): void {
  const current = readTelemetry(cwd);
  writeTelemetry(cwd, {
    ...current,
    updatedAt: new Date().toISOString(),
    modelContextCalls: current.modelContextCalls + 1,
    pruneEvents: current.pruneEvents + (stats.prunedToolResults > 0 ? 1 : 0),
    prunedToolResults: current.prunedToolResults + stats.prunedToolResults,
    cumulativeCharsBefore: current.cumulativeCharsBefore + stats.charsBefore,
    cumulativeCharsAfter: current.cumulativeCharsAfter + stats.charsAfter,
    cumulativeCharsPruned: current.cumulativeCharsPruned + stats.charsPruned,
    cumulativeBytesBefore: current.cumulativeBytesBefore + stats.bytesBefore,
    cumulativeBytesAfter: current.cumulativeBytesAfter + stats.bytesAfter,
    cumulativeBytesPruned: current.cumulativeBytesPruned + stats.bytesPruned,
    cumulativeEstimatedTokensBefore:
      current.cumulativeEstimatedTokensBefore + stats.estimatedTokensBefore,
    cumulativeEstimatedTokensAfter:
      current.cumulativeEstimatedTokensAfter + stats.estimatedTokensAfter,
    cumulativeEstimatedTokensPruned:
      current.cumulativeEstimatedTokensPruned + stats.estimatedTokensPruned,
    lastObservation: { ...stats, observedAt: new Date().toISOString() },
  });
}

function incrementTelemetry(
  cwd: string,
  field: "compactionEvents" | "recoveryRefetchEvents",
): void {
  const current = readTelemetry(cwd);
  writeTelemetry(cwd, {
    ...current,
    updatedAt: new Date().toISOString(),
    [field]: current[field] + 1,
  });
}

function piNextContextActive(cwd: string): boolean {
  if (existsSync(planFile(cwd))) return true;
  const loopPath = join(runtimeDir(cwd), "pi-next-loop.json");
  if (!existsSync(loopPath)) return false;
  try {
    const state = JSON.parse(readFileSync(loopPath, "utf8")) as { status?: string };
    return state.status === "running";
  } catch {
    return false;
  }
}

export function registerContextPruning(pi: ExtensionAPI): void {
  const recentlyPrunedTools = new Set<string>();

  pi.on("context", async (event, ctx) => {
    if (!piNextContextActive(ctx.cwd)) return;
    const result = (() => {
      try {
        return prunePiNextContext(event.messages);
      } catch {
        // Context hooks are on the model request path; malformed host data
        // must fall through unchanged rather than unload the extension host.
        return undefined;
      }
    })();
    if (!result) return;
    try {
      recordObservation(ctx.cwd, result.stats);
    } catch {
      // Telemetry is best-effort. A runtime filesystem failure must not turn a
      // context hook rejection into an extension-host crash.
    }
    for (const toolName of result.prunedToolNames) recentlyPrunedTools.add(toolName);
    if (!result.stats.prunedToolResults) return;
    return { messages: result.messages as typeof event.messages };
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!piNextContextActive(ctx.cwd)) return;
    try {
      incrementTelemetry(ctx.cwd, "compactionEvents");
    } catch {
      // Telemetry must never make compaction fail.
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!piNextContextActive(ctx.cwd)) return;
    if (!recentlyPrunedTools.has(event.toolName)) return;
    recentlyPrunedTools.delete(event.toolName);
    try {
      incrementTelemetry(ctx.cwd, "recoveryRefetchEvents");
    } catch {
      // Telemetry must never make tool execution fail.
    }
  });
}

// A resolved `session.prompt()` promise is transport completion, not proof that the
// underlying model turn actually succeeded (see #151). This module inspects the
// terminal assistant `message_end` event the same way the Pi SDK's own print-mode
// renderer does (stopReason "error" / "aborted" => failure), so worker completion
// stays evidence-based instead of inferred from promise resolution alone.

export type WorkerFailureCode = "MODEL_TURN_FAILED" | "MODEL_TURN_UNPROVEN";

export interface WorkerTerminalEvidence {
  sawAssistantMessage: boolean;
  stopReason?: string;
  errorMessage?: string;
}

export function createWorkerTerminalEvidence(): WorkerTerminalEvidence {
  return { sawAssistantMessage: false };
}

function asAssistantMessageEnd(event: unknown): { stopReason?: string; errorMessage?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; message?: unknown };
  if (item.type !== "message_end" || !item.message || typeof item.message !== "object") return undefined;
  const message = item.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (message.role !== "assistant") return undefined;
  return {
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  };
}

/** Update terminal evidence from a raw worker session event. Keeps the latest assistant message_end seen. */
export function observeWorkerEvent(evidence: WorkerTerminalEvidence, event: unknown): WorkerTerminalEvidence {
  const assistantMessage = asAssistantMessageEnd(event);
  if (!assistantMessage) return evidence;
  return { sawAssistantMessage: true, stopReason: assistantMessage.stopReason, errorMessage: assistantMessage.errorMessage };
}

export type WorkerCompletionClassification =
  | { ok: true }
  | { ok: false; code: WorkerFailureCode; detail: string };

/**
 * Classify a resolved `session.prompt()` call using mechanical terminal evidence.
 * Only a terminal assistant result proven successful (or at least observed, for
 * stop reasons that are not themselves failure signals) counts as completion.
 */
export function classifyWorkerCompletion(evidence: WorkerTerminalEvidence): WorkerCompletionClassification {
  if (evidence.stopReason === "error" || evidence.stopReason === "aborted") {
    return {
      ok: false,
      code: "MODEL_TURN_FAILED",
      detail: evidence.errorMessage || `terminal model result reported stopReason=${evidence.stopReason}`,
    };
  }
  if (!evidence.sawAssistantMessage) {
    return {
      ok: false,
      code: "MODEL_TURN_UNPROVEN",
      detail: "session.prompt() resolved without a mechanically observed terminal assistant result",
    };
  }
  return { ok: true };
}

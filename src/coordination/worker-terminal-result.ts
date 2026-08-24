// A resolved `session.prompt()` promise is transport completion, not proof that the
// underlying model turn actually succeeded (see #151). This module normalizes the
// bounded terminal semantics exposed by Pi/worker adapters (assistant
// `message_end`/`turn_end`, raw stream `done`/`error`, and retry/provider error
// events) so worker completion is evidence-based rather than inferred from
// promise resolution alone.

export type WorkerFailureCode = "MODEL_TURN_FAILED" | "MODEL_TURN_ABORTED" | "MODEL_TURN_UNPROVEN" | "PROVIDER_ERROR";

export type WorkerTerminalResultKind =
  | "assistant_message_end"
  | "turn_end"
  | "agent_end"
  | "stream_done"
  | "stream_error"
  | "provider_error";

export interface WorkerTerminalEvidence {
  /** Any bounded terminal model/provider outcome was observed. */
  terminalResultObserved: boolean;
  /** A terminal assistant/model message was observed. Provider-error events may be terminal without one. */
  sawAssistantMessage: boolean;
  /** Assistant text/content was observed. Diagnostic only, never a success oracle by itself. */
  assistantOutputObserved: boolean;
  resultKind?: WorkerTerminalResultKind;
  stopReason?: string;
  rawStopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

export function createWorkerTerminalEvidence(): WorkerTerminalEvidence {
  return { terminalResultObserved: false, sawAssistantMessage: false, assistantOutputObserved: false };
}

const SUCCESS_STOP_REASONS = new Set([
  // Pi's normalized successful AssistantMessageEventStream "done" reasons.
  "stop",
  "length",
  "toolUse",
  "deferred",
  // Provider/raw aliases seen in deterministic fakes and upstream provider docs
  // before Pi normalizes them to the values above.
  "end_turn",
  "stop_sequence",
]);

const FAILURE_STOP_REASONS = new Set(["error", "aborted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 1_000);
}

function assistantTextObserved(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!isRecord(part)) return false;
    return part.type === "text" && typeof part.text === "string" && part.text.length > 0;
  });
}

function messageObservation(
  message: unknown,
  resultKind: WorkerTerminalResultKind,
): Partial<WorkerTerminalEvidence> | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  return {
    terminalResultObserved: true,
    sawAssistantMessage: true,
    assistantOutputObserved: assistantTextObserved(message),
    resultKind,
    stopReason: stringField(message, "stopReason"),
    rawStopReason: stringField(message, "rawStopReason"),
    errorCode: stringField(message, "errorCode") ?? stringField(message, "code"),
    errorMessage: boundedString(message.errorMessage),
    provider: stringField(message, "provider"),
    model: stringField(message, "model") ?? stringField(message, "responseModel"),
  };
}

function latestAssistant(messages: unknown): unknown | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (isRecord(candidate) && candidate.role === "assistant") return candidate;
  }
  return undefined;
}

function errorMessageFrom(value: unknown): string | undefined {
  if (typeof value === "string") return boundedString(value);
  if (!isRecord(value)) return undefined;
  return boundedString(value.errorMessage)
    ?? boundedString(value.message)
    ?? boundedString(value.error)
    ?? boundedString(value.finalError);
}

function errorCodeFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringField(value, "code") ?? stringField(value, "type") ?? stringField(value, "name");
}

function providerErrorObservation(event: Record<string, unknown>): Partial<WorkerTerminalEvidence> | undefined {
  if (event.type === "auto_retry_end" && event.success === false) {
    return {
      terminalResultObserved: true,
      sawAssistantMessage: false,
      assistantOutputObserved: false,
      resultKind: "provider_error",
      stopReason: "error",
      errorCode: "AUTO_RETRY_EXHAUSTED",
      errorMessage: errorMessageFrom(event.finalError) ?? errorMessageFrom(event),
    };
  }

  if (event.type === "provider_error" || event.type === "model_error" || event.type === "runtime_error") {
    return {
      terminalResultObserved: true,
      sawAssistantMessage: false,
      assistantOutputObserved: false,
      resultKind: "provider_error",
      stopReason: stringField(event, "stopReason") ?? stringField(event, "reason") ?? "error",
      errorCode: stringField(event, "code") ?? stringField(event, "errorCode") ?? String(event.type).toUpperCase(),
      errorMessage: errorMessageFrom(event),
      provider: stringField(event, "provider"),
      model: stringField(event, "model"),
    };
  }

  if (event.type === "error") {
    const nested = isRecord(event.error) ? event.error : undefined;
    const assistantError = nested ? messageObservation(nested, "stream_error") : undefined;
    if (assistantError) return { ...assistantError, stopReason: assistantError.stopReason ?? stringField(event, "reason") ?? "error" };
    return {
      terminalResultObserved: true,
      sawAssistantMessage: false,
      assistantOutputObserved: false,
      resultKind: "stream_error",
      stopReason: stringField(event, "reason") ?? "error",
      errorCode: errorCodeFrom(nested) ?? stringField(event, "code") ?? stringField(event, "errorCode"),
      errorMessage: errorMessageFrom(nested) ?? errorMessageFrom(event),
    };
  }

  return undefined;
}

function assistantOutputDeltaObserved(event: Record<string, unknown>): boolean {
  const update = event.assistantMessageEvent;
  if (!isRecord(update)) return false;
  if (update.type === "text_delta" && typeof update.delta === "string" && update.delta.length > 0) return true;
  if (update.type === "text_end" && typeof update.content === "string" && update.content.length > 0) return true;
  const partial = update.partial;
  return isRecord(partial) && assistantTextObserved(partial);
}

function mergeObservation(evidence: WorkerTerminalEvidence, observation: Partial<WorkerTerminalEvidence>): WorkerTerminalEvidence {
  return {
    ...evidence,
    ...observation,
    terminalResultObserved: observation.terminalResultObserved ?? evidence.terminalResultObserved,
    sawAssistantMessage: observation.sawAssistantMessage ?? evidence.sawAssistantMessage,
    assistantOutputObserved: evidence.assistantOutputObserved || observation.assistantOutputObserved === true,
  };
}

/** Update terminal evidence from a raw worker session event. Keeps terminal state scoped to one worker invocation. */
export function observeWorkerEvent(evidence: WorkerTerminalEvidence, event: unknown): WorkerTerminalEvidence {
  if (!isRecord(event)) return evidence;

  let next = evidence;
  if (assistantOutputDeltaObserved(event)) {
    next = { ...next, assistantOutputObserved: true };
  }

  const providerError = providerErrorObservation(event);
  if (providerError) return mergeObservation(next, providerError);

  if (event.type === "message_end") {
    const observation = messageObservation(event.message, "assistant_message_end");
    return observation ? mergeObservation(next, observation) : next;
  }

  if (event.type === "turn_end") {
    const observation = messageObservation(event.message, "turn_end");
    return observation ? mergeObservation(next, observation) : next;
  }

  if (event.type === "done") {
    const observation = messageObservation(event.message, "stream_done");
    return observation ? mergeObservation(next, { ...observation, stopReason: observation.stopReason ?? stringField(event, "reason") }) : next;
  }

  if (event.type === "agent_end" && !next.terminalResultObserved) {
    const observation = messageObservation(latestAssistant(event.messages), "agent_end");
    return observation ? mergeObservation(next, observation) : next;
  }

  return next;
}

export type WorkerCompletionClassification =
  | { ok: true }
  | { ok: false; code: WorkerFailureCode; detail: string };

/**
 * Classify a resolved `session.prompt()` call using mechanical terminal evidence.
 * Only a terminal result with a known successful model stop reason counts as
 * completion. Missing, malformed, unknown, provider-error, and aborted terminal
 * shapes fail closed.
 */
export function classifyWorkerCompletion(evidence: WorkerTerminalEvidence): WorkerCompletionClassification {
  if (!evidence.terminalResultObserved) {
    return {
      ok: false,
      code: "MODEL_TURN_UNPROVEN",
      detail: "session.prompt() resolved without a mechanically observed terminal model result",
    };
  }

  if (!evidence.stopReason) {
    return {
      ok: false,
      code: "MODEL_TURN_UNPROVEN",
      detail: `${evidence.resultKind ?? "terminal model result"} did not include a terminal stopReason`,
    };
  }

  if (evidence.stopReason === "aborted") {
    return {
      ok: false,
      code: "MODEL_TURN_ABORTED",
      detail: evidence.errorMessage || "terminal model result reported stopReason=aborted",
    };
  }

  if (evidence.stopReason === "error" || evidence.resultKind === "provider_error" || evidence.resultKind === "stream_error") {
    const detail = evidence.errorCode && evidence.errorMessage
      ? `${evidence.errorCode}: ${evidence.errorMessage}`
      : evidence.errorMessage || evidence.errorCode || `terminal model result reported stopReason=${evidence.stopReason}`;
    return {
      ok: false,
      code: evidence.resultKind === "provider_error" || evidence.errorCode ? "PROVIDER_ERROR" : "MODEL_TURN_FAILED",
      detail,
    };
  }

  if (FAILURE_STOP_REASONS.has(evidence.stopReason)) {
    return {
      ok: false,
      code: "MODEL_TURN_FAILED",
      detail: evidence.errorMessage || `terminal model result reported stopReason=${evidence.stopReason}`,
    };
  }

  if (!SUCCESS_STOP_REASONS.has(evidence.stopReason)) {
    return {
      ok: false,
      code: "MODEL_TURN_UNPROVEN",
      detail: `terminal model result reported unknown stopReason=${evidence.stopReason}`,
    };
  }

  return { ok: true };
}

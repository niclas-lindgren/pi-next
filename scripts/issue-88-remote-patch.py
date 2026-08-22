from pathlib import Path

source_path = Path("scripts/bootstrap-self-host.ts")
source = source_path.read_text()

old = '''function extractEventText(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as Record<string, unknown>;
  for (const key of ["text", "content", "message", "response", "output"]) {
    const value = item[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const joined = value.map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
      if (joined) return joined;
    }
  }
  return undefined;
}
'''
new = '''function extractAssistantTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = event as { type?: unknown; assistantMessageEvent?: unknown };
  if (item.type !== "message_update" || !item.assistantMessageEvent || typeof item.assistantMessageEvent !== "object") return undefined;
  const assistantEvent = item.assistantMessageEvent as { type?: unknown; delta?: unknown };
  return assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
}
'''
if old not in source:
    raise SystemExit("expected extractEventText block not found")
source = source.replace(old, new, 1)

old = '  const eventTexts: string[] = [];\n'
new = '  let assistantText = "";\n'
if old not in source:
    raise SystemExit("expected eventTexts declaration not found")
source = source.replace(old, new, 1)

old = '''      const text = extractEventText(event);
      if (text) eventTexts.push(text.slice(-4_000));
'''
new = '''      const delta = extractAssistantTextDelta(event);
      if (delta) assistantText = `${assistantText}${delta}`.slice(-16_000);
'''
if old not in source:
    raise SystemExit("expected event text subscription block not found")
source = source.replace(old, new, 1)

old = '      reviewResult: role === "review" ? (sanitizeReviewResult(session.getStructuredResult?.()) ?? parseReviewResultText(eventTexts.at(-1))) : undefined,\n'
new = '      reviewResult: role === "review" ? parseReviewResultText(assistantText) : undefined,\n'
if old not in source:
    raise SystemExit("expected reviewResult extraction line not found")
source = source.replace(old, new, 1)

old = '  getStructuredResult?: () => unknown;\n'
if old not in source:
    raise SystemExit("expected getStructuredResult interface line not found")
source = source.replace(old, "", 1)
source_path.write_text(source)

test_path = Path("test/bootstrap-self-host.test.ts")
tests = test_path.read_text()
old = '''    const session: WorkerSession = {
      model: { provider: "fake", id: "scripted" },
      subscribe: () => () => undefined,
      prompt: async (prompt) => {
        record.prompt = prompt;
        await action(role, cwd, prompt);
      },
      abort: async () => {
        record.aborted = true;
      },
      dispose: () => {
        record.disposed = true;
      },
      getSessionStats: stats,
      getStructuredResult: () => structured?.(role),
    };
'''
new = '''    let listener: ((event: unknown) => void) | undefined;
    const session: WorkerSession = {
      model: { provider: "fake", id: "scripted" },
      subscribe: (next) => {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
      prompt: async (prompt) => {
        record.prompt = prompt;
        await action(role, cwd, prompt);
        const result = structured?.(role);
        if (result !== undefined && listener) {
          const text = JSON.stringify(result);
          const split = Math.max(1, Math.floor(text.length / 2));
          for (const delta of [text.slice(0, split), text.slice(split)]) {
            if (!delta) continue;
            listener({
              type: "message_update",
              message: { role: "assistant", content: [] },
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
            });
          }
        }
      },
      abort: async () => {
        record.aborted = true;
      },
      dispose: () => {
        record.disposed = true;
      },
      getSessionStats: stats,
    };
'''
if old not in tests:
    raise SystemExit("expected fakeFactory session block not found")
tests = tests.replace(old, new, 1)
test_path.write_text(tests)

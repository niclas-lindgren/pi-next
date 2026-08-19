const RECENT_MESSAGE_TAIL = 12
const MIN_PRUNABLE_CHARS = 8_000
const APPROX_CHARS_PER_TOKEN = 4
const PRUNABLE_TOOL_NAMES = new Set(["read", "grep", "find", "ls"])
const textEncoder = new TextEncoder()

function estimateTokens(chars) {
  return Math.ceil(Math.max(0, chars) / APPROX_CHARS_PER_TOKEN)
}

function contentSize(content) {
  if (typeof content === "string") {
    return { chars: content.length, bytes: textEncoder.encode(content).length }
  }
  if (!Array.isArray(content)) return { chars: 0, bytes: 0 }
  let chars = 0
  let bytes = 0
  for (const block of content) {
    if (!block || typeof block !== "object") return null
    if (block.type !== "text" || typeof block.text !== "string") return null
    chars += block.text.length
    bytes += textEncoder.encode(block.text).length
  }
  return { chars, bytes }
}

function totalContextSize(messages) {
  return messages.reduce(
    (total, item) => {
      if (!item || typeof item !== "object") return total
      const size = contentSize(item.content)
      if (!size) return total
      return { chars: total.chars + size.chars, bytes: total.bytes + size.bytes }
    },
    { chars: 0, bytes: 0 },
  )
}

function canPruneToolResult(message, index, messageCount) {
  if (index >= Math.max(0, messageCount - RECENT_MESSAGE_TAIL)) return false
  if (message.role !== "toolResult" || message.isError !== false) return false
  if (!message.toolName || !PRUNABLE_TOOL_NAMES.has(message.toolName)) return false
  const size = contentSize(message.content)
  return size !== null && size.chars >= MIN_PRUNABLE_CHARS
}

export function prunePiNextContext(messages) {
  const before = totalContextSize(messages)
  const prunedToolNames = new Set()
  let prunedToolResults = 0

  const next = messages.map((item, index) => {
    if (!item || typeof item !== "object") return item
    if (!canPruneToolResult(item, index, messages.length)) return item

    const original = contentSize(item.content) ?? { chars: 0, bytes: 0 }
    const toolName = item.toolName
    prunedToolResults += 1
    prunedToolNames.add(toolName)
    return {
      ...item,
      content: [
        {
          type: "text",
          text: `[pi-next context pruning: omitted ${original.chars} characters from an older successful ${toolName} result. The stored session entry is unchanged; re-run ${toolName} against the canonical source if this evidence becomes relevant again.]`,
        },
      ],
    }
  })

  const after = totalContextSize(next)
  const charsPruned = Math.max(0, before.chars - after.chars)
  const bytesPruned = Math.max(0, before.bytes - after.bytes)
  return {
    messages: next,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: next.length,
      prunedToolResults,
      charsBefore: before.chars,
      charsAfter: after.chars,
      charsPruned,
      bytesBefore: before.bytes,
      bytesAfter: after.bytes,
      bytesPruned,
      estimatedTokensBefore: estimateTokens(before.chars),
      estimatedTokensAfter: estimateTokens(after.chars),
      estimatedTokensPruned: estimateTokens(charsPruned),
    },
    prunedToolNames: [...prunedToolNames].sort(),
  }
}

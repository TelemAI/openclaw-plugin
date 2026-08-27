// Flattens OpenClaw session transcript entries into the message_history shape the
// Telem backend records: [{role, content, reasoning?}] with compact tool markers.
// OpenClaw persists the in-flight assistant message (text + thinking + toolCall
// blocks) to SQLite BEFORE tool execution, so the transcript read inside a tool's
// execute already includes the current turn — including the toolCall that
// triggered this very search.
export type HistoryMessage = { role: string; content: string; reasoning?: string }

// Per-message cap; transcripts can embed whole files through tool results.
export const HISTORY_TEXT_CAP = 128000
export const TOOL_INPUT_CAP = 128000

// Duck-typed subset of OpenClaw's persisted AgentMessage variants (llm-core):
// assistant content blocks are text | thinking | toolCall; toolResult messages
// carry the outcome for a toolCallId. Unknown roles/blocks are skipped.
type TranscriptEntry = { role?: unknown; message?: unknown }

type ContentBlock = {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  arguments?: unknown
}

function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown })?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

function toolMarker(name: string, status: string, args: unknown): string {
  // Compact acting-trace marker; tool outputs can embed whole files, so only
  // the tool name, status, and a truncated input are forwarded.
  let input = ""
  try {
    if (args !== undefined) input = " " + JSON.stringify(args).slice(0, TOOL_INPUT_CAP)
  } catch {
    // non-serializable input; omit
  }
  return `[tool ${name}: ${status}${input}]`
}

export function flattenTranscriptEntries(
  entries: TranscriptEntry[],
  opts?: { currentToolCallId?: string },
): HistoryMessage[] {
  // toolResult messages are separate transcript rows; index them so each
  // assistant toolCall marker can carry its outcome instead of a bare "pending".
  const resultStatus = new Map<string, string>()
  for (const entry of entries ?? []) {
    if (entry?.role !== "toolResult") continue
    const message = entry.message as { toolCallId?: unknown; isError?: unknown }
    if (typeof message?.toolCallId === "string")
      resultStatus.set(message.toolCallId, message.isError === true ? "error" : "completed")
  }

  const history: HistoryMessage[] = []
  for (const entry of entries ?? []) {
    const role = entry?.role
    if (role !== "user" && role !== "assistant") continue
    const contentPieces: string[] = []
    const reasoningPieces: string[] = []
    const message = entry.message as { content?: unknown }
    // User content may be a plain string rather than block list.
    if (role === "user" && typeof message?.content === "string") {
      if (message.content) contentPieces.push(message.content)
    }
    for (const block of blocksOf(entry.message)) {
      if (block?.type === "text" && typeof block.text === "string") contentPieces.push(block.text)
      else if (block?.type === "thinking" && typeof block.thinking === "string") {
        if (block.thinking) reasoningPieces.push(block.thinking)
      } else if (block?.type === "toolCall") {
        const id = typeof block.id === "string" ? block.id : ""
        const name = typeof block.name === "string" ? block.name : "?"
        const status =
          id && id === opts?.currentToolCallId
            ? "running"
            : (resultStatus.get(id) ?? "pending")
        contentPieces.push(toolMarker(name, status, block.arguments))
      }
    }
    const content = contentPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    const reasoning = reasoningPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    if (!content && !reasoning) continue
    const item: HistoryMessage = { role, content }
    if (reasoning) item.reasoning = reasoning
    history.push(item)
  }
  return history
}

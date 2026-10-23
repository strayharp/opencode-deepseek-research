function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Return the last assistant text in a session context.
 *
 * Session context ends with an `idle` marker after a completed turn, so the
 * marker (and any system messages) are skipped. Any tool-call part means the
 * assistant was still working rather than producing a final answer.
 */
export function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message)) return undefined
    if (message.type === "idle" || message.type === "system") continue
    if (message.type !== "assistant" || message.error) return undefined
    const content = Array.isArray(message.content) ? message.content : []
    if (content.some((part) => isRecord(part) && part.type === "tool")) return undefined
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n\n")
      .trim()
    return text.length > 0 ? text : undefined
  }
  return undefined
}

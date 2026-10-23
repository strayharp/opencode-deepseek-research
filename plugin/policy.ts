export type Effort = "low" | "high" | "max"

export const RESEARCH_RULES = `科研模式（DeepSeek V4.1 Flash 1017）：
1) 事实性断言必须带来源（DOI/arXiv/URL/文件路径）；没有来源就写 insufficient evidence。
2) 数字必须由工具复算；不要心算，不要引用未运行的实验结果。
3) 先给实验设计（假设、变量、baseline、指标、停止条件），再执行。
4) 记录 seed、config、数据版本、git SHA；区分相关与因果。
5) 最终答案给出：结论 / 证据 / 不确定性 / 可复现步骤。
6) 最终答案前必须调用 verify：answer 传最终文本，claims 覆盖关键数字/引用/实验/代码；pass=false 时先修复，无法验证就写 insufficient evidence。
7) 仅对高价值且可验证的任务使用 best_of_n（3–5 个独立候选 + 评审）；简单任务走单次，避免无谓成本。`

export const COMPACTION_RULES = `科研压缩要求：
保留：研究问题与假设；已确认结论及证据（DOI/arXiv/URL/文件路径）；关键数字与单位；实验配置（seed、数据版本、git SHA、baseline、指标）；实验/运行 ID 与 artifact 路径（含 job id）；失败尝试及原因；未解决问题；下一步行动。
删除：工具闲聊、重复输出、已被推翻的方案、无关日志。
规则：不得编造缺失信息；无法确认的写成 insufficient evidence；路径、URL、ID、数字保持原样。
输出：按“目标 / 已确认证据 / 实验状态 / 未决问题 / 下一步”分节。`

const EFFORT_BY_AGENT: Readonly<Record<string, Effort>> = {
  scout: "low",
  writer: "low",
  critic: "max",
  experimenter: "high",
  analyst: "high",
}

const MAX_TOKENS_BY_AGENT: Readonly<Record<string, number>> = {
  scout: 8_000,
  writer: 32_000,
  critic: 16_000,
  experimenter: 16_000,
  analyst: 16_000,
  compaction: 12_000,
}

export function effortFor(agent: string): Effort {
  return EFFORT_BY_AGENT[agent] ?? "high"
}

export function maxTokensFor(agent: string): number {
  return MAX_TOKENS_BY_AGENT[agent] ?? 16_000
}

export function hasResearchRules(system: readonly { text?: string }[]): boolean {
  return system.some((part) => typeof part.text === "string" && part.text.includes("科研模式"))
}

export function hasCompactionRules(system: readonly { text?: string }[]): boolean {
  return system.some((part) => typeof part.text === "string" && part.text.includes("科研压缩要求"))
}

export interface TokenSnapshot {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface CacheStats {
  promptTokens: number
  cachedTokens: number
  hitRate: number
  totalTokens: number
}

/** Below this prompt size, a low hit rate is usually just a cold cache. */
export const CACHE_AUDIT_MIN_PROMPT_TOKENS = 200_000
/** DeepSeek's cache is cheap enough that a sub-50% hit rate is worth surfacing. */
export const CACHE_AUDIT_MIN_HIT_RATE = 0.5

export function cacheStats(tokens: TokenSnapshot): CacheStats {
  const promptTokens = tokens.input + tokens.cache.read + tokens.cache.write
  const cachedTokens = tokens.cache.read
  const totalTokens = promptTokens + tokens.output + tokens.reasoning
  return {
    promptTokens,
    cachedTokens,
    hitRate: promptTokens === 0 ? 0 : cachedTokens / promptTokens,
    totalTokens,
  }
}

export function shouldWarnCache(
  stats: CacheStats,
  minPromptTokens = CACHE_AUDIT_MIN_PROMPT_TOKENS,
  minHitRate = CACHE_AUDIT_MIN_HIT_RATE,
): boolean {
  return stats.promptTokens >= minPromptTokens && stats.hitRate < minHitRate
}

export interface CacheAuditEvent {
  type: string
  data?: {
    sessionID?: string
    tokens?: TokenSnapshot
  }
}

export interface CacheAuditorOptions {
  save: (sessionID: string, stats: CacheStats) => void | Promise<void>
  warn: (message: string, error?: unknown) => void
  /** Injectable for tests; one warning per session by default. */
  warned?: Set<string>
  minPromptTokens?: number
  minHitRate?: number
}

/**
 * Turns cumulative `session.usage.updated` events into a compact cache report.
 * Returns true when the event was a usage event and was processed.
 */
export function createCacheAuditor(options: CacheAuditorOptions) {
  const warned = options.warned ?? new Set<string>()
  const minPromptTokens = options.minPromptTokens ?? CACHE_AUDIT_MIN_PROMPT_TOKENS
  const minHitRate = options.minHitRate ?? CACHE_AUDIT_MIN_HIT_RATE

  return async (event: CacheAuditEvent): Promise<boolean> => {
    if (event.type !== "session.usage.updated") return false
    const sessionID = event.data?.sessionID
    const tokens = event.data?.tokens
    if (!sessionID || !tokens) return false

    const stats = cacheStats(tokens)
    try {
      await options.save(sessionID, stats)
    } catch (error) {
      options.warn(`[deepseek-research] failed to persist cache stats for ${sessionID}`, error)
    }

    if (shouldWarnCache(stats, minPromptTokens, minHitRate) && !warned.has(sessionID)) {
      warned.add(sessionID)
      options.warn(
        `[deepseek-research] low prompt-cache hit rate for ${sessionID}: ` +
          `${(stats.hitRate * 100).toFixed(1)}% of ${stats.promptTokens} prompt tokens ` +
          `(warning threshold ${minHitRate * 100}%). Check stable system prefixes.`,
      )
    }

    return true
  }
}

export const TOOL_RESULT_LIMIT = 32_000

export interface PruneResult {
  text: string
  spilled: boolean
  originalChars: number
}

export function pruneToolText(text: string, spillPath: string, limit = TOOL_RESULT_LIMIT): PruneResult {
  const originalChars = text.length
  if (originalChars <= limit) return { text, spilled: false, originalChars }

  const header = `[deepseek-research] Full output (${originalChars} chars) spilled to: ${spillPath}\n`
  const footer = `\n[deepseek-research] Preview only. Read the spill file for the full output.`
  // Reserve room for the omitted-count marker and the two inserted newlines.
  const budget = limit - header.length - footer.length - 200

  if (budget < 200) {
    const room = Math.max(0, limit - header.length)
    return {
      text: `${header}${text.slice(0, room)}`,
      spilled: true,
      originalChars,
    }
  }

  const head = Math.floor(budget * 0.7)
  const tail = budget - head
  return {
    text:
      `${header}${text.slice(0, head)}\n` +
      `... [${originalChars - head - tail} chars omitted] ...\n` +
      `${text.slice(originalChars - tail)}${footer}`,
    spilled: true,
    originalChars,
  }
}

export function spillPathFor(baseDir: string, sessionID: string, callID: string): string {
  const trimmed = baseDir.replace(/\/+$/, "")
  return `${trimmed}/${sessionID}/${callID}.txt`
}

export interface ToolAfterEvent {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly status: "completed" | "error"
  readonly result?: {
    content?: string | readonly { type: string; text?: string }[]
    metadata?: Record<string, unknown>
  }
}

export interface ToolResultPrunerOptions {
  limit?: number
  spillPath: (sessionID: string, callID: string) => string
  writeSpill: (path: string, text: string) => Promise<void>
  warn?: (message: string, error?: unknown) => void
}

type ToolContent = string | readonly { type: string; text?: string }[]

function contentText(content: ToolContent): string | undefined {
  if (typeof content === "string") return content
  const parts: string[] = []
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
  }
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

function withTextContent(content: ToolContent, text: string): ToolContent {
  if (typeof content === "string") return text
  const files = content.filter((part) => part.type !== "text")
  return [{ type: "text", text }, ...files]
}

/**
 * Spills oversized tool results to disk and leaves a bounded preview in the
 * model context. Handles both plain strings and structured text/file parts
 * (the shell tool and several MCP tools return the latter).
 */
export function createToolResultPruner(options: ToolResultPrunerOptions) {
  const limit = options.limit ?? TOOL_RESULT_LIMIT
  const warn = options.warn ?? (() => {})

  return async (event: ToolAfterEvent): Promise<boolean> => {
    const result = event.result
    if (event.status !== "completed" || !result || result.content === undefined) return false

    const text = contentText(result.content)
    if (text === undefined || text.length <= limit) return false

    const path = options.spillPath(event.sessionID, event.id)
    try {
      await options.writeSpill(path, text)
    } catch (error) {
      warn(`[deepseek-research] failed to spill output of ${event.tool} (${event.id})`, error)
      return false
    }

    const pruned = pruneToolText(text, path, limit)
    result.content = withTextContent(result.content, pruned.text)
    result.metadata = {
      ...result.metadata,
      deepseekResearchSpill: path,
      originalChars: pruned.originalChars,
    }
    return true
  }
}

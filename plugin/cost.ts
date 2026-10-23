export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface CostBucket {
  cost: number
  tokens: TokenUsage
  steps: number
  failedSteps: number
}

export interface CostSessionRecord {
  version: 1
  sessionID: string
  parentID?: string
  title?: string
  totalCost: number
  tokens: TokenUsage
  steps: number
  failedSteps: number
  byAgent: Record<string, CostBucket>
  byModel: Record<string, CostBucket>
  usageSeen: boolean
  unpricedSteps: number
  createdAt: string
  updatedAt: string
}

export type BudgetScope = "project" | "task" | "session"
export type CostGroupBy = "task" | "session" | "agent" | "model"

export interface BudgetConfig {
  usd?: number
  scope?: BudgetScope
}

export interface BudgetStatus {
  limited: boolean
  exceeded: boolean
  reasons: readonly "usd"[]
  usd: number
  usdLimit?: number
  scope: BudgetScope
}

export interface CostStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  scan?(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

export interface CostEvent {
  type?: string
  data?: Record<string, any>
}

export interface CostTrackerOptions {
  storage: CostStorage
  projectID: string
  prefix?: string
  budgets?: BudgetConfig
  now?: () => Date
  warn?: (message: string, error?: unknown) => void
  onExceeded?: (input: { sessionID?: string; status: BudgetStatus }) => void | Promise<void>
}

export interface CostGroup {
  key: string
  label: string
  cost: number
  tokens: TokenUsage
  steps: number
  failedSteps: number
  sessions: number
}

export interface CostReportInput {
  groupBy?: CostGroupBy
  sessionID?: string
  format?: "markdown" | "json"
}

export interface CostReport {
  generatedAt: string
  groupBy: CostGroupBy
  sessionID?: string
  totalCost: number
  tokens: TokenUsage
  steps: number
  failedSteps: number
  sessions: number
  unattributedCost: number
  unpricedSteps: number
  groups: readonly CostGroup[]
  budget: BudgetStatus
}

export interface CostTracker {
  load(): Promise<void>
  handle(event: CostEvent): Promise<boolean>
  check(sessionID?: string): Promise<BudgetStatus>
  enforce(sessionID: string | undefined, status: BudgetStatus): Promise<boolean>
  isBlocked(sessionID?: string): boolean
  report(input?: CostReportInput): Promise<CostReport>
}

interface PendingStep {
  sessionID: string
  agent: string
  model: string
}

const EMPTY_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const MAX_PENDING_STEPS = 2_000

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function positive(value: unknown): number | undefined {
  const number = finite(value)
  return number > 0 ? number : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function emptyTokens(): TokenUsage {
  return { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } }
}

export function normalizeTokens(value: unknown): TokenUsage {
  const input = value && typeof value === "object" ? (value as Record<string, any>) : {}
  const cache = input.cache && typeof input.cache === "object" ? (input.cache as Record<string, any>) : {}
  return {
    input: Math.max(0, finite(input.input)),
    output: Math.max(0, finite(input.output)),
    reasoning: Math.max(0, finite(input.reasoning)),
    cache: {
      read: Math.max(0, finite(cache.read)),
      write: Math.max(0, finite(cache.write)),
    },
  }
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
  }
}

export function totalTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function emptyBucket(): CostBucket {
  return { cost: 0, tokens: emptyTokens(), steps: 0, failedSteps: 0 }
}

function addBucket(bucket: CostBucket | undefined, cost: number, tokens: TokenUsage, failed: boolean): CostBucket {
  const next = bucket ?? emptyBucket()
  next.cost += cost
  next.tokens = addTokens(next.tokens, tokens)
  next.steps += 1
  if (failed) next.failedSteps += 1
  return next
}

function modelLabel(model: unknown): string {
  if (!model || typeof model !== "object") return "unknown"
  const value = model as Record<string, any>
  const provider = text(value.providerID) ?? "unknown"
  const id = text(value.id) ?? "unknown"
  const variant = text(value.variant)
  return `${provider}/${id}${variant ? `#${variant}` : ""}`
}

function recordKey(prefix: string, sessionID: string): string {
  return `${prefix}:${sessionID}`
}

function recordFrom(value: unknown, sessionID: string): CostSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, any>
  if (input.sessionID !== undefined && input.sessionID !== sessionID) return undefined
  const now = new Date().toISOString()
  const byAgent: Record<string, CostBucket> = {}
  const byModel: Record<string, CostBucket> = {}
  for (const [key, bucket] of Object.entries(input.byAgent ?? {})) {
    if (!bucket || typeof bucket !== "object") continue
    const current = bucket as Record<string, any>
    byAgent[key] = {
      cost: Math.max(0, finite(current.cost)),
      tokens: normalizeTokens(current.tokens),
      steps: Math.max(0, Math.floor(finite(current.steps))),
      failedSteps: Math.max(0, Math.floor(finite(current.failedSteps))),
    }
  }
  for (const [key, bucket] of Object.entries(input.byModel ?? {})) {
    if (!bucket || typeof bucket !== "object") continue
    const current = bucket as Record<string, any>
    byModel[key] = {
      cost: Math.max(0, finite(current.cost)),
      tokens: normalizeTokens(current.tokens),
      steps: Math.max(0, Math.floor(finite(current.steps))),
      failedSteps: Math.max(0, Math.floor(finite(current.failedSteps))),
    }
  }
  return {
    version: 1,
    sessionID,
    ...(text(input.parentID) ? { parentID: text(input.parentID) } : {}),
    ...(text(input.title) ? { title: text(input.title) } : {}),
    totalCost: Math.max(0, finite(input.totalCost)),
    tokens: normalizeTokens(input.tokens),
    steps: Math.max(0, Math.floor(finite(input.steps))),
    failedSteps: Math.max(0, Math.floor(finite(input.failedSteps))),
    byAgent,
    byModel,
    usageSeen: input.usageSeen === true,
    unpricedSteps: Math.max(0, Math.floor(finite(input.unpricedSteps))),
    createdAt: text(input.createdAt) ?? now,
    updatedAt: text(input.updatedAt) ?? now,
  }
}

function newRecord(sessionID: string, now: string): CostSessionRecord {
  return {
    version: 1,
    sessionID,
    totalCost: 0,
    tokens: emptyTokens(),
    steps: 0,
    failedSteps: 0,
    byAgent: {},
    byModel: {},
    usageSeen: false,
    unpricedSteps: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function mergeRecord(record: CostSessionRecord, value: unknown): void {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, any>
  if (input.totalCost !== undefined) record.totalCost = Math.max(record.totalCost, finite(input.totalCost))
  if (input.tokens !== undefined) record.tokens = normalizeTokens(input.tokens)
  if (input.usageSeen === true) record.usageSeen = true
}

function formatUSD(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`
  return `$${value.toFixed(4)}`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function rootOf(records: ReadonlyMap<string, CostSessionRecord>, sessionID: string): string {
  let current = sessionID
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = records.get(current)?.parentID
    if (!parent || parent === current) return current
    current = parent
  }
  return current
}

function mergeGroups(groups: Map<string, CostGroup>, group: CostGroup): void {
  const current = groups.get(group.key)
  if (!current) {
    groups.set(group.key, { ...group, tokens: { ...group.tokens, cache: { ...group.tokens.cache } } })
    return
  }
  current.cost += group.cost
  current.tokens = addTokens(current.tokens, group.tokens)
  current.steps += group.steps
  current.failedSteps += group.failedSteps
  current.sessions += group.sessions
}

function sortGroups(groups: Iterable<CostGroup>): CostGroup[] {
  return [...groups].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
}

export function budgetNotice(status: BudgetStatus): string {
  const lines = [
    "[deepseek-research] 预算守卫已停止当前任务。",
    `范围：${status.scope}`,
    `美元：${formatUSD(status.usd)}${status.usdLimit === undefined ? "" : ` / ${formatUSD(status.usdLimit)}`}`,
  ]
  if (status.reasons.length > 0) lines.push(`超限项：${status.reasons.join(", ")}`)
  lines.push("调整配置中的 budgetUSD，或新建任务后再继续。")
  return lines.join("\n")
}

export function formatCostReport(report: CostReport): string {
  const lines = [
    "# DeepSeek Research Cost Report",
    `Generated: ${report.generatedAt}`,
    `Scope: ${report.sessionID ? `task ${report.sessionID}` : "project"} | Group: ${report.groupBy}`,
    `Total: ${formatUSD(report.totalCost)} | ${formatNumber(totalTokens(report.tokens))} tokens | ` +
      `${formatNumber(report.steps)} steps | ${report.sessions} sessions`,
    `Budget: ${report.budget.limited ? (report.budget.exceeded ? "EXCEEDED" : "ok") : "off"} ` +
      `(USD ${formatUSD(report.budget.usd)}` +
      `${report.budget.usdLimit === undefined ? "" : ` / ${formatUSD(report.budget.usdLimit)}`})`,
  ]
  if (report.unattributedCost > 0) lines.push(`Unattributed: ${formatUSD(report.unattributedCost)}`)
  if (report.unpricedSteps > 0) lines.push(`Unpriced steps: ${report.unpricedSteps}`)
  lines.push(
    "",
    "| " +
      (report.groupBy === "agent"
        ? "Agent"
        : report.groupBy === "model"
          ? "Model"
          : report.groupBy === "session"
            ? "Session"
            : "Task") +
      " | USD | Tokens | Steps | Failed | Sessions |",
    "|---|---:|---:|---:|---:|---:|",
  )
  for (const group of report.groups) {
    lines.push(
      `| ${escapeCell(group.label)} | ${formatUSD(group.cost)} | ${formatNumber(totalTokens(group.tokens))} | ` +
        `${formatNumber(group.steps)} | ${formatNumber(group.failedSteps)} | ${formatNumber(group.sessions)} |`,
    )
  }
  lines.push("", "> USD comes from provider-reported usage cost. This is a local project ledger, not cloud billing.")
  return lines.join("\n")
}

export function createCostTracker(options: CostTrackerOptions): CostTracker {
  const prefix = options.prefix ?? `cost:${options.projectID}`
  const now = options.now ?? (() => new Date())
  const warn = options.warn ?? (() => {})
  const budgets = options.budgets ?? {}
  const scope = budgets.scope ?? "project"
  const records = new Map<string, CostSessionRecord>()
  const pending = new Map<string, PendingStep>()
  const blocked = new Set<string>()
  let loaded = false
  let loading: Promise<void> | undefined

  async function scanAll(scanPrefix: string): Promise<{ key: string; value: unknown }[]> {
    if (typeof options.storage.scan !== "function") return []
    const entries: { key: string; value: unknown }[] = []
    let after: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const result = await options.storage.scan({ prefix: scanPrefix, ...(after ? { after } : {}), limit: 100 })
      entries.push(...result.entries)
      if (!result.next || result.next === after) break
      after = result.next
    }
    return entries
  }

  async function load(): Promise<void> {
    if (loaded) return
    if (loading) return loading
    loading = (async () => {
      try {
        for (const entry of await scanAll(prefix)) {
          const sessionID = entry.key.slice(prefix.length + 1)
          if (!sessionID) continue
          const record = recordFrom(entry.value, sessionID)
          if (record) records.set(sessionID, record)
        }
      } catch (error) {
        warn("[deepseek-research] failed to load cost records", error)
      } finally {
        loaded = true
        loading = undefined
      }
    })()
    return loading
  }

  async function save(record: CostSessionRecord): Promise<void> {
    record.updatedAt = now().toISOString()
    try {
      await options.storage.set(recordKey(prefix, record.sessionID), { ...record })
    } catch (error) {
      warn(`[deepseek-research] failed to persist cost record for ${record.sessionID}`, error)
    }
  }

  function ensureRecord(sessionID: string, data?: Record<string, any>): CostSessionRecord {
    let record = records.get(sessionID)
    if (!record) {
      record = newRecord(sessionID, now().toISOString())
      records.set(sessionID, record)
    }
    if (data) {
      if (text(data.parentID)) record.parentID = text(data.parentID)
      if (text(data.title)) record.title = text(data.title)
      mergeRecord(record, data)
    }
    return record
  }

  function selectedRecords(sessionID?: string, selectedScope: BudgetScope = scope): CostSessionRecord[] {
    const all = [...records.values()]
    if (selectedScope === "project" || !sessionID) return all
    if (selectedScope === "session") return all.filter((record) => record.sessionID === sessionID)
    const root = rootOf(records, sessionID)
    return all.filter((record) => rootOf(records, record.sessionID) === root)
  }

  async function check(sessionID?: string): Promise<BudgetStatus> {
    const usdLimit = positive(budgets.usd)
    if (usdLimit === undefined) {
      return { limited: false, exceeded: false, reasons: [], usd: 0, scope }
    }
    await load()
    const usd = selectedRecords(sessionID).reduce((sum, record) => sum + record.totalCost, 0)
    const reasons: "usd"[] = usd >= usdLimit ? ["usd"] : []
    return {
      limited: true,
      exceeded: reasons.length > 0,
      reasons,
      usd,
      usdLimit,
      scope,
    }
  }

  function blockedKey(sessionID: string | undefined, selectedScope: BudgetScope): string {
    if (selectedScope === "project" || !sessionID) return "project"
    if (selectedScope === "session") return `session:${sessionID}`
    return `task:${rootOf(records, sessionID)}`
  }

  function isBlocked(sessionID?: string): boolean {
    if (blocked.has("project")) return true
    if (!sessionID) return false
    return blocked.has(`task:${rootOf(records, sessionID)}`) || blocked.has(`session:${sessionID}`)
  }

  async function enforce(sessionID: string | undefined, status: BudgetStatus): Promise<boolean> {
    if (!status.exceeded) return false
    const key = blockedKey(sessionID, status.scope)
    if (blocked.has(key)) return false
    blocked.add(key)
    try {
      await options.onExceeded?.({ sessionID, status })
    } catch (error) {
      warn("[deepseek-research] budget exceeded callback failed", error)
    }
    return true
  }

  function applyUsage(
    record: CostSessionRecord,
    agent: string,
    model: string,
    cost: number,
    tokens: TokenUsage,
    failed: boolean,
  ): void {
    record.byAgent[agent] = addBucket(record.byAgent[agent], cost, tokens, failed)
    record.byModel[model] = addBucket(record.byModel[model], cost, tokens, failed)
    record.steps += 1
    if (failed) record.failedSteps += 1
    if (cost === 0 && totalTokens(tokens) > 0) record.unpricedSteps += 1
    if (!record.usageSeen) {
      record.totalCost += cost
      record.tokens = addTokens(record.tokens, tokens)
    }
  }

  async function handle(event: CostEvent): Promise<boolean> {
    const type = event.type
    const data = event.data ?? {}
    if (!type || !type.startsWith("session.")) return false
    await load()
    const sessionID = text(data.sessionID)
    if (!sessionID) return false

    if (type === "session.created") {
      const record = ensureRecord(sessionID, data)
      record.parentID = text(data.parentID)
      record.title = text(data.title)
      await save(record)
      return true
    }

    if (type === "session.step.started") {
      const messageID = text(data.assistantMessageID)
      if (!messageID) return false
      ensureRecord(sessionID)
      pending.set(messageID, {
        sessionID,
        agent: text(data.agent) ?? "unknown",
        model: modelLabel(data.model),
      })
      if (pending.size > MAX_PENDING_STEPS) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
      }
      return true
    }

    if (type === "session.step.ended" || type === "session.step.failed") {
      const messageID = text(data.assistantMessageID)
      const step = messageID ? pending.get(messageID) : undefined
      if (messageID) pending.delete(messageID)
      const cost = Math.max(0, finite(data.cost))
      const tokens = normalizeTokens(data.tokens)
      if (cost === 0 && totalTokens(tokens) === 0) {
        if (type === "session.step.failed") {
          const record = ensureRecord(sessionID)
          record.failedSteps += 1
          await save(record)
        }
        return true
      }
      const record = ensureRecord(sessionID)
      applyUsage(
        record,
        step?.agent ?? "unknown",
        step?.model ?? "unknown",
        cost,
        tokens,
        type === "session.step.failed",
      )
      await save(record)
      const status = await check(sessionID)
      if (status.exceeded) await enforce(sessionID, status)
      return true
    }

    if (type === "session.usage.recorded") {
      const source = text(data.source) ?? "auxiliary"
      const record = ensureRecord(sessionID)
      applyUsage(record, `aux:${source}`, `aux:${source}`, Math.max(0, finite(data.cost)), normalizeTokens(data.tokens), false)
      await save(record)
      return true
    }

    if (type === "session.usage.updated") {
      const record = ensureRecord(sessionID)
      record.totalCost = Math.max(0, finite(data.cost))
      record.tokens = normalizeTokens(data.tokens)
      record.usageSeen = true
      await save(record)
      const status = await check(sessionID)
      if (status.exceeded) await enforce(sessionID, status)
      return true
    }

    return false
  }

  async function report(input: CostReportInput = {}): Promise<CostReport> {
    await load()
    const groupBy = input.groupBy ?? "task"
    const selected = selectedRecords(input.sessionID, "task")
    const totalCost = selected.reduce((sum, record) => sum + record.totalCost, 0)
    const tokens = selected.reduce((sum, record) => addTokens(sum, record.tokens), emptyTokens())
    const steps = selected.reduce((sum, record) => sum + record.steps, 0)
    const failedSteps = selected.reduce((sum, record) => sum + record.failedSteps, 0)
    const unattributedCost = Math.max(
      0,
      selected.reduce((sum, record) => {
        const attributed = Object.values(record.byAgent).reduce((total, bucket) => total + bucket.cost, 0)
        return sum + Math.max(0, record.totalCost - attributed)
      }, 0),
    )
    const groups = new Map<string, CostGroup>()

    if (groupBy === "task" || groupBy === "session") {
      for (const record of selected) {
        const key = groupBy === "task" ? rootOf(records, record.sessionID) : record.sessionID
        const label = groupBy === "task" ? records.get(key)?.title ?? key : record.title ?? record.sessionID
        mergeGroups(groups, {
          key,
          label,
          cost: record.totalCost,
          tokens: record.tokens,
          steps: record.steps,
          failedSteps: record.failedSteps,
          sessions: 1,
        })
      }
    } else {
      for (const record of selected) {
        const buckets = groupBy === "agent" ? record.byAgent : record.byModel
        for (const [key, bucket] of Object.entries(buckets)) {
          mergeGroups(groups, {
            key,
            label: key,
            cost: bucket.cost,
            tokens: bucket.tokens,
            steps: bucket.steps,
            failedSteps: bucket.failedSteps,
            sessions: 1,
          })
        }
      }
    }

    const budget = await check(input.sessionID)
    const scopeSessionID = input.sessionID ? rootOf(records, input.sessionID) : undefined
    return {
      generatedAt: now().toISOString(),
      groupBy,
      ...(scopeSessionID ? { sessionID: scopeSessionID } : {}),
      totalCost,
      tokens,
      steps,
      failedSteps,
      sessions: selected.length,
      unattributedCost,
      unpricedSteps: selected.reduce((sum, record) => sum + record.unpricedSteps, 0),
      groups: sortGroups(groups.values()),
      budget,
    }
  }

  return { load, handle, check, enforce, isBlocked, report }
}

const costReportInputSchema = {
  type: "object",
  properties: {
    groupBy: {
      type: "string",
      enum: ["task", "session", "agent", "model"],
      description: "Aggregate by root task, session, agent, or model (default task).",
    },
    sessionID: {
      type: "string",
      description: "Limit the report to this task's root session and its children.",
    },
    format: { type: "string", enum: ["markdown", "json"], description: "Output format (default markdown)." },
  },
  additionalProperties: false,
}

export interface CostToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  options: { codemode: false }
  execute: (input: CostReportInput, context?: unknown) => Promise<{
    content: string
    metadata?: Record<string, unknown>
  }>
}

export function createCostReportTool(tracker: CostTracker): CostToolDefinition {
  return {
    name: "cost_report",
    description:
      "Show research cost and usage by task, session, agent, or model, including USD, tokens, steps, and sessions. This tool is read-only and remains available after a budget stop.",
    input: costReportInputSchema,
    options: { codemode: false },
    execute: async (input: CostReportInput, context?: unknown) => {
      const request = input ?? {}
      const contextSessionID =
        context && typeof context === "object" && typeof (context as any).sessionID === "string"
          ? (context as any).sessionID
          : undefined
      const sessionID = request.sessionID ?? contextSessionID
      const report = await tracker.report({ ...request, ...(sessionID ? { sessionID } : {}) })
      return {
        content: request.format === "json" ? JSON.stringify(report, null, 2) : formatCostReport(report),
        metadata: {
          totalCostUSD: report.totalCost,
          totalTokens: totalTokens(report.tokens),
          sessions: report.sessions,
          budgetExceeded: report.budget.exceeded,
          groups: report.groups.length,
        },
      }
    },
  }
}

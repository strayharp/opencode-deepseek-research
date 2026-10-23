import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

export type ExperimentStatus = "planned" | "running" | "completed" | "failed" | "aborted"

export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  "planned",
  "running",
  "completed",
  "failed",
  "aborted",
]

export interface Experiment {
  id: string
  hypothesis: string
  config: Record<string, unknown>
  seed?: number
  datasetHash?: string
  gitSha?: string
  command?: string
  metrics: Record<string, number>
  status: ExperimentStatus
  startedAt?: string
  finishedAt?: string
  artifacts: string[]
  cwd: string
  createdAt: string
  updatedAt: string
}

export interface RecordExperimentInput {
  id?: string
  hypothesis?: string
  config?: Record<string, unknown>
  seed?: number
  datasetHash?: string
  gitSha?: string
  command?: string
  metrics?: Record<string, number>
  status?: ExperimentStatus
  startedAt?: string
  finishedAt?: string
  artifacts?: string[]
  /** Working directory of the run. */
  cwd?: string
}

export interface QueryExperimentsInput {
  id?: string
  status?: ExperimentStatus
  metric?: string
  min?: number
  max?: number
  limit?: number
}

export interface CompareExperimentsInput {
  baseline: string
  candidate: string
}

export interface BestExperimentsInput {
  metric: string
  mode?: "max" | "min"
  status?: ExperimentStatus
  limit?: number
}

export interface ExperimentSummary {
  id: string
  hypothesis: string
  status: ExperimentStatus
  seed?: number
  datasetHash?: string
  gitSha?: string
  command?: string
  artifacts: string[]
  updatedAt: string
}

export interface ExperimentStore {
  get(id: string): Promise<Experiment | undefined>
  put(experiment: Experiment): Promise<void>
  list(): Promise<Experiment[]>
}

export interface ExperimentStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

export interface RecordExperimentOptions {
  baseDir: string
  now?: () => string
  generateId?: (now: string) => string
}

export interface RecordExperimentResult {
  experiment: Experiment
  created: boolean
}

export interface ExperimentToolResult {
  content: string
  metadata?: Record<string, unknown>
}

export interface ExperimentToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  options: { codemode: false }
  execute: (input: any, context?: unknown) => Promise<ExperimentToolResult>
}

export interface ExperimentToolOptions {
  store: ExperimentStore
  baseDir: string
  now?: () => string
  generateId?: (now: string) => string
}

const STATUS_SET = new Set<string>(EXPERIMENT_STATUSES)

function fail(message: string): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be a JSON object`)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export function isValidExperimentId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
}

export function isExperiment(value: unknown): value is Experiment {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || !isValidExperimentId(value.id)) return false
  if (typeof value.hypothesis !== "string") return false
  if (!isRecord(value.config) || !isRecord(value.metrics)) return false
  if (!Object.values(value.metrics).every((metric) => typeof metric === "number" && Number.isFinite(metric))) {
    return false
  }
  if (!isStringArray(value.artifacts)) return false
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) return false
  if (typeof value.cwd !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return false
  }
  if (value.seed !== undefined && (typeof value.seed !== "number" || !Number.isInteger(value.seed))) return false
  for (const field of ["datasetHash", "gitSha", "command", "startedAt", "finishedAt"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false
  }
  return true
}

export function createExperimentStore(storage: ExperimentStorage, prefix: string): ExperimentStore {
  const key = (id: string) => `${prefix}:${id}`
  return {
    async get(id) {
      if (!isValidExperimentId(id)) fail(`invalid experiment id: ${id}`)
      const value = await storage.get(key(id))
      return isExperiment(value) ? value : undefined
    },
    async put(experiment) {
      await storage.set(key(experiment.id), experiment)
    },
    async list() {
      const experiments: Experiment[] = []
      let after: string | undefined
      do {
        const page = await storage.scan({ prefix: `${prefix}:`, after, limit: 100 })
        for (const entry of page.entries) {
          if (isExperiment(entry.value)) experiments.push(entry.value)
        }
        after = page.next
      } while (after)
      return experiments
    },
  }
}

export function defaultExperimentId(now: string): string {
  const stamp = now.replace(/[^0-9]/g, "").slice(0, 14)
  const random = Math.random().toString(36).slice(2, 8) || "000000"
  return `exp-${stamp}-${random}`
}

export function normalizeArtifact(baseDir: string, artifact: string): string {
  const value = artifact.trim()
  if (!value) fail("artifact paths must not be empty")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || isAbsolute(value)) return value
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return resolve(baseDir, value)
}

function normalizeWorkingDirectory(baseDir: string, cwd: string): string {
  const value = cwd.trim()
  if (!value) return baseDir
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return resolve(baseDir, value)
}

function normalizeTimestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) fail(`${field} must be an ISO timestamp`)
  return date.toISOString()
}

function isTerminalStatus(status: ExperimentStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted"
}

export async function recordExperiment(
  store: ExperimentStore,
  input: RecordExperimentInput,
  options: RecordExperimentOptions,
): Promise<RecordExperimentResult> {
  if (input.id !== undefined && !isValidExperimentId(input.id)) fail(`invalid experiment id: ${input.id}`)

  const now = (options.now ?? (() => new Date().toISOString()))()
  const id = input.id ?? (options.generateId ?? defaultExperimentId)(now)
  if (!isValidExperimentId(id)) fail(`invalid experiment id: ${id}`)
  const existing = input.id ? await store.get(id) : undefined

  if (input.config !== undefined) assertPlainObject(input.config, "config")
  if (input.metrics !== undefined) {
    assertPlainObject(input.metrics, "metrics")
    for (const [key, value] of Object.entries(input.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`metrics.${key} must be a finite number`)
    }
  }
  if (input.artifacts !== undefined && !isStringArray(input.artifacts)) fail("artifacts must be an array of strings")
  if (input.seed !== undefined && !Number.isInteger(input.seed)) fail("seed must be an integer")
  if (input.status !== undefined && !STATUS_SET.has(input.status)) fail(`invalid experiment status: ${input.status}`)

  const hypothesis = (input.hypothesis ?? existing?.hypothesis ?? "").trim()
  if (!hypothesis) fail("hypothesis is required when creating an experiment")

  const hasMetrics = input.metrics !== undefined && Object.keys(input.metrics).length > 0
  const status = input.status ?? existing?.status ?? (hasMetrics ? "completed" : input.command ? "running" : "planned")
  const config = { ...(existing?.config ?? {}), ...(input.config ?? {}) }
  const metrics = { ...(existing?.metrics ?? {}), ...(input.metrics ?? {}) }
  const artifacts =
    input.artifacts !== undefined
      ? input.artifacts.map((artifact) => normalizeArtifact(options.baseDir, artifact))
      : [...(existing?.artifacts ?? [])]
  const seed = input.seed ?? existing?.seed
  const datasetHash = input.datasetHash ?? existing?.datasetHash
  const gitSha = input.gitSha ?? existing?.gitSha
  const command = input.command ?? existing?.command
  const cwd = input.cwd !== undefined ? normalizeWorkingDirectory(options.baseDir, input.cwd) : existing?.cwd ?? options.baseDir

  const explicitFinishedAt = normalizeTimestamp(input.finishedAt, "finishedAt")
  let startedAt = normalizeTimestamp(input.startedAt, "startedAt") ?? existing?.startedAt
  let finishedAt = explicitFinishedAt ?? existing?.finishedAt
  if (status === "planned" && input.startedAt === undefined) startedAt = undefined
  if ((status === "running" || status === "planned") && input.finishedAt === undefined) finishedAt = undefined
  if (startedAt === undefined && status !== "planned") startedAt = now
  if (
    input.status !== undefined &&
    input.status !== existing?.status &&
    isTerminalStatus(status) &&
    explicitFinishedAt === undefined
  ) {
    finishedAt = now
  }
  if (finishedAt === undefined && isTerminalStatus(status)) finishedAt = now

  const experiment: Experiment = {
    id,
    hypothesis,
    config,
    ...(seed !== undefined ? { seed } : {}),
    ...(datasetHash !== undefined ? { datasetHash } : {}),
    ...(gitSha !== undefined ? { gitSha } : {}),
    ...(command !== undefined ? { command } : {}),
    metrics,
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    artifacts,
    cwd,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await store.put(experiment)
  return { experiment, created: !existing }
}

export async function queryExperiments(
  store: ExperimentStore,
  input: QueryExperimentsInput,
): Promise<Experiment[]> {
  if (input.status !== undefined && !STATUS_SET.has(input.status)) fail(`invalid experiment status: ${input.status}`)
  if (input.id) {
    const experiment = await store.get(input.id)
    return experiment ? [experiment] : []
  }
  const limit = clampInt(input.limit, 20, 1, 100)
  const experiments = await store.list()
  return experiments
    .filter((experiment) => {
      if (input.status !== undefined && experiment.status !== input.status) return false
      if (input.metric) {
        const value = experiment.metrics[input.metric]
        if (typeof value !== "number" || !Number.isFinite(value)) return false
        if (input.min !== undefined && value < input.min) return false
        if (input.max !== undefined && value > input.max) return false
      }
      return true
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, limit)
}

export interface MetricComparison {
  baseline: number | null
  candidate: number | null
  delta: number | null
  pct: number | null
}

export interface ExperimentComparison {
  baseline: ExperimentSummary
  candidate: ExperimentSummary
  metrics: Record<string, MetricComparison>
  configDiff: Record<string, { baseline: unknown; candidate: unknown }>
  differences: Record<string, { baseline: unknown; candidate: unknown }>
}

export function summarizeExperiment(experiment: Experiment): ExperimentSummary {
  return {
    id: experiment.id,
    hypothesis: experiment.hypothesis,
    status: experiment.status,
    ...(experiment.seed !== undefined ? { seed: experiment.seed } : {}),
    ...(experiment.datasetHash ? { datasetHash: experiment.datasetHash } : {}),
    ...(experiment.gitSha ? { gitSha: experiment.gitSha } : {}),
    ...(experiment.command ? { command: experiment.command } : {}),
    artifacts: experiment.artifacts,
    updatedAt: experiment.updatedAt,
  }
}

export async function compareExperiments(
  store: ExperimentStore,
  input: CompareExperimentsInput,
): Promise<ExperimentComparison> {
  const baseline = await store.get(input.baseline)
  if (!baseline) fail(`experiment not found: ${input.baseline}`)
  const candidate = await store.get(input.candidate)
  if (!candidate) fail(`experiment not found: ${input.candidate}`)

  const keys = new Set([...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics)])
  const metrics: Record<string, MetricComparison> = {}
  for (const key of keys) {
    const a = baseline.metrics[key]
    const b = candidate.metrics[key]
    const comparable = typeof a === "number" && typeof b === "number"
    metrics[key] = {
      baseline: typeof a === "number" ? a : null,
      candidate: typeof b === "number" ? b : null,
      delta: comparable ? b - a : null,
      pct: comparable && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null,
    }
  }

  const configKeys = new Set([...Object.keys(baseline.config), ...Object.keys(candidate.config)])
  const configDiff: Record<string, { baseline: unknown; candidate: unknown }> = {}
  for (const key of configKeys) {
    if (JSON.stringify(baseline.config[key]) === JSON.stringify(candidate.config[key])) continue
    configDiff[key] = {
      baseline: baseline.config[key] ?? null,
      candidate: candidate.config[key] ?? null,
    }
  }

  const differences: Record<string, { baseline: unknown; candidate: unknown }> = {}
  for (const key of ["seed", "datasetHash", "gitSha"] as const) {
    if (baseline[key] === candidate[key]) continue
    differences[key] = {
      baseline: baseline[key] ?? null,
      candidate: candidate[key] ?? null,
    }
  }

  return {
    baseline: summarizeExperiment(baseline),
    candidate: summarizeExperiment(candidate),
    metrics,
    configDiff,
    differences,
  }
}

export interface BestExperimentsResult {
  metric: string
  mode: "max" | "min"
  status: ExperimentStatus
  count: number
  ranking: { experiment: ExperimentSummary; value: number }[]
}

export async function bestExperiments(
  store: ExperimentStore,
  input: BestExperimentsInput,
): Promise<BestExperimentsResult> {
  const metric = input.metric?.trim()
  if (!metric) fail("metric is required")
  const mode = input.mode ?? "max"
  if (mode !== "max" && mode !== "min") fail(`invalid mode: ${mode}`)
  const status = input.status ?? "completed"
  if (!STATUS_SET.has(status)) fail(`invalid experiment status: ${status}`)

  const experiments = (await store.list()).filter((experiment) => {
    if (experiment.status !== status) return false
    const value = experiment.metrics[metric]
    return typeof value === "number" && Number.isFinite(value)
  })
  if (experiments.length === 0) fail(`no ${status} experiments with metric: ${metric}`)

  experiments.sort((a, b) => {
    const av = a.metrics[metric]!
    const bv = b.metrics[metric]!
    return mode === "max" ? bv - av : av - bv
  })

  const limit = clampInt(input.limit, 5, 1, 20)
  return {
    metric,
    mode,
    status,
    count: experiments.length,
    ranking: experiments.slice(0, limit).map((experiment) => ({
      experiment: summarizeExperiment(experiment),
      value: experiment.metrics[metric],
    })),
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

const STATUS_SCHEMA = {
  type: "string",
  enum: [...EXPERIMENT_STATUSES],
  description: "planned | running | completed | failed | aborted",
}

const recordInputSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      description: "Existing experiment id to update. Omit to create a new record.",
    },
    hypothesis: { type: "string", description: "Research hypothesis for this run." },
    config: { type: "object", additionalProperties: true, description: "Model/data/training configuration." },
    seed: { type: "integer", description: "Random seed used by the run." },
    datasetHash: { type: "string", description: "Dataset version or content hash." },
    gitSha: { type: "string", description: "Code revision used by the run." },
    command: { type: "string", description: "Exact command that produced the run." },
    metrics: {
      type: "object",
      additionalProperties: { type: "number" },
      description: "Numeric metrics, e.g. accuracy, loss, F1.",
    },
    status: STATUS_SCHEMA,
    startedAt: { type: "string", description: "ISO timestamp." },
    finishedAt: { type: "string", description: "ISO timestamp." },
    cwd: { type: "string", description: "Working directory of the run." },
    artifacts: {
      type: "array",
      items: { type: "string" },
      description: "Paths or URIs to checkpoints, logs, metrics, and figures.",
    },
  },
  additionalProperties: false,
}

const queryInputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Look up one experiment by id." },
    status: STATUS_SCHEMA,
    metric: { type: "string", description: "Only return experiments that logged this metric." },
    min: { type: "number", description: "Minimum value for the selected metric." },
    max: { type: "number", description: "Maximum value for the selected metric." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Newest records to return (default 20)." },
  },
  additionalProperties: false,
}

const compareInputSchema = {
  type: "object",
  properties: {
    baseline: { type: "string", description: "Baseline experiment id." },
    candidate: { type: "string", description: "Candidate experiment id." },
  },
  required: ["baseline", "candidate"],
  additionalProperties: false,
}

const bestInputSchema = {
  type: "object",
  properties: {
    metric: { type: "string", description: "Metric to rank by." },
    mode: { type: "string", enum: ["max", "min"], description: "Higher or lower is better (default max)." },
    status: STATUS_SCHEMA,
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Ranking size (default 5)." },
  },
  required: ["metric"],
  additionalProperties: false,
}

export function createExperimentTools(options: ExperimentToolOptions): ExperimentToolDefinition[] {
  const recordOptions: RecordExperimentOptions = {
    baseDir: options.baseDir,
    now: options.now,
    generateId: options.generateId,
  }

  return [
    {
      name: "exp_record",
      description:
        "Record or update a reproducible experiment: hypothesis, config, seed, dataset hash, git SHA, command, metrics, status, and artifact paths. Use an existing id to update status or metrics after a run.",
      input: recordInputSchema,
      options: { codemode: false },
      execute: async (input: RecordExperimentInput) => {
        const result = await recordExperiment(options.store, input, recordOptions)
        return {
          content: JSON.stringify({ created: result.created, experiment: result.experiment }, null, 2),
          metadata: { id: result.experiment.id, status: result.experiment.status, created: result.created },
        }
      },
    },
    {
      name: "exp_query",
      description:
        "Query this project's experiment registry by id, status, or metric range. Returns newest records first, including seed, git SHA, metrics, and artifact paths.",
      input: queryInputSchema,
      options: { codemode: false },
      execute: async (input: QueryExperimentsInput) => {
        const experiments = await queryExperiments(options.store, input)
        return {
          content: JSON.stringify({ count: experiments.length, experiments }, null, 2),
          metadata: { count: experiments.length },
        }
      },
    },
    {
      name: "exp_compare",
      description:
        "Compare two experiments: metric deltas and percent changes, config differences, and seed/dataset/git mismatches that affect reproducibility.",
      input: compareInputSchema,
      options: { codemode: false },
      execute: async (input: CompareExperimentsInput) => {
        const comparison = await compareExperiments(options.store, input)
        return {
          content: JSON.stringify(comparison, null, 2),
          metadata: { baseline: input.baseline, candidate: input.candidate },
        }
      },
    },
    {
      name: "exp_best",
      description:
        "Rank experiments by a numeric metric and return the best runs. Defaults to completed experiments, descending order, top 5.",
      input: bestInputSchema,
      options: { codemode: false },
      execute: async (input: BestExperimentsInput) => {
        const result = await bestExperiments(options.store, input)
        return {
          content: JSON.stringify(result, null, 2),
          metadata: { metric: result.metric, mode: result.mode, count: result.count },
        }
      },
    },
  ]
}



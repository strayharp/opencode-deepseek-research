import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { extname, isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import type { Experiment, ExperimentStore } from "./experiments.ts"

const execFileAsync = promisify(execFile)

export type VerifyClaimType = "number" | "citation" | "file" | "experiment" | "code"

export interface VerifyClaim {
  type: VerifyClaimType
  label?: string
  value?: number
  source?: string
  path?: string
  tolerance?: number
  unit?: string
  requireUnit?: boolean
  network?: boolean
  ids?: string[]
  metric?: string
  minSeeds?: number
  maxStd?: number
  ci?: number
  maxCiWidth?: number
  baseline?: string
  requireBaseline?: boolean
  language?: "python" | "bash" | "javascript" | "json"
}

export interface VerifyInput {
  answer?: string
  claims?: VerifyClaim[]
  strict?: boolean
  scanAnswer?: boolean
  network?: boolean
}

export interface VerifyIssue {
  type: string
  severity: "error" | "warning"
  detail: string
  claim?: number
}

export interface VerifyStats {
  ids: string[]
  metric?: string
  values?: number[]
  seeds?: number[]
  mean?: number
  std?: number
  ci?: [number, number]
  baseline?: number
  delta?: number
  pct?: number
}

export interface VerifyResult {
  pass: boolean
  gate: "ok" | "rewrite"
  issues: VerifyIssue[]
  evidence: string[]
  checks: {
    numbers: number
    citations: number
    files: number
    experiments: number
    code: number
  }
  stats?: Record<string, VerifyStats>
  answer?: {
    numbers: number
    citations: number
    unverifiedNumbers: number
    uncheckedCitations: number
  }
}

export interface VerifyStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface VerifyOptions {
  baseDir: string
  experiments: ExperimentStore
  pythonPath?: string
  network?: boolean
  fetchImpl?: typeof fetch
  now?: () => string
}

export interface VerificationReceipt {
  answerHash: string
  pass: boolean
  issueCount: number
  issues?: string[]
  at: string
}

export interface VerifyToolOptions extends VerifyOptions {
  storage?: VerifyStorage
  projectID?: string
  now?: () => string
}

const DEFAULT_CITATION_TIMEOUT_MS = 5_000
const MAX_ISSUES = 50
const MAX_EVIDENCE = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return value
}

function resolvePath(baseDir: string, value: string): string {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
}

function normalizeUnit(value: string): string {
  const unit = value.trim().toLowerCase().replace(/\s+/g, "")
  if (unit === "percent" || unit === "percentage" || unit === "pct") return "%"
  return unit
}

function uniquePush(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value)
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeCitation(value: string): string {
  const trimmed = value.trim().replace(/[),.;]+$/, "")
  if (/^arxiv:/i.test(trimmed)) return `https://arxiv.org/abs/${trimmed.replace(/^arxiv:\s*/i, "")}`
  if (/^doi:/i.test(trimmed)) return `https://doi.org/${trimmed.replace(/^doi:\s*/i, "")}`
  if (/^10\.\d{4,9}\//.test(trimmed)) return `https://doi.org/${trimmed}`
  return trimmed
}

function citationKey(value: string): string {
  return normalizeCitation(value).toLowerCase().replace(/\/+$/, "")
}

function looksLikeLocalPath(value: string): boolean {
  if (/^(?:https?|ftp):\/\//i.test(value)) return false
  if (/^doi:/i.test(value) || /^arxiv:/i.test(value)) return false
  if (/^10\.\d{4,9}\//.test(value)) return false
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    /\.(?:md|markdown|pdf|txt|json|jsonl|csv|tsv|html?|png|jpe?g|svg|tex|bib)$/i.test(value)
  )
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ""
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""))
      rows.push(row)
      row = []
      cell = ""
    } else {
      cell += char
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""))
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((value) => value.trim().length > 0))
}

function getAtPath(value: unknown, path: string): unknown {
  const normalized = path
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
  if (!normalized) return value
  let current: unknown = value
  for (const key of normalized.split(".").filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
    } else if (isRecord(current)) {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

function collectNumbers(value: unknown, values: number[] = [], units: string[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    values.push(value)
    return values
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    values.push(Number(value))
    return values
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectNumbers(entry, values, units)
    return values
  }
  if (!isRecord(value)) return values

  if (typeof value.value === "number" && Number.isFinite(value.value)) values.push(value.value)
  const unit = value.unit ?? value.units
  if (typeof unit === "string") units.push(unit)
  for (const [key, entry] of Object.entries(value)) {
    if (key === "value" || key === "unit" || key === "units") continue
    collectNumbers(entry, values, units)
  }
  return values
}

interface NumberSource {
  values: number[]
  units: string[]
  evidence: string
}

async function readExperimentNumbers(
  source: string,
  claim: VerifyClaim,
  options: VerifyOptions,
): Promise<NumberSource> {
  const id = source.replace(/^(?:experiment|exp):/i, "").trim()
  if (!id) throw new Error("experiment id is empty")
  const experiment = await options.experiments.get(id)
  if (!experiment) throw new Error(`experiment not found: ${id}`)
  const metric = claim.metric ?? claim.path
  const values = metric ? [experiment.metrics[metric]] : Object.values(experiment.metrics)
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(metric ? `metric not found: ${metric}` : `experiment has no numeric metrics: ${id}`)
  }
  return { values: values as number[], units: [], evidence: `experiment:${id}` }
}

async function readNumberSource(
  source: string,
  claim: VerifyClaim,
  options: VerifyOptions,
): Promise<NumberSource> {
  if (/^(?:experiment|exp):/i.test(source)) return readExperimentNumbers(source, claim, options)

  const path = resolvePath(options.baseDir, source)
  const text = await readFile(path, "utf8")
  const extension = extname(path).toLowerCase()
  const values: number[] = []
  const units: string[] = []

  if (extension === ".jsonl" || extension === ".ndjson") {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      const selected = claim.path ? getAtPath(parsed, claim.path) : parsed
      if (selected === undefined) throw new Error(`path not found: ${claim.path}`)
      collectNumbers(selected, values, units)
    }
  } else if (extension === ".csv" || extension === ".tsv") {
    const rows = parseDelimited(text, extension === ".tsv" ? "\t" : ",")
    if (rows.length === 0) throw new Error(`empty table: ${source}`)
    const header = rows[0]!
    const body = rows.slice(1)
    if (claim.path) {
      const column = header.indexOf(claim.path)
      if (column === -1) throw new Error(`column not found: ${claim.path}`)
      for (const row of body) {
        const value = Number(row[column])
        if (Number.isFinite(value)) values.push(value)
      }
    } else {
      for (const row of body) {
        for (const cell of row) {
          const value = Number(cell)
          if (Number.isFinite(value)) values.push(value)
        }
      }
    }
  } else {
    const parsed = JSON.parse(text)
    const selected = claim.path ? getAtPath(parsed, claim.path) : parsed
    if (selected === undefined) throw new Error(`path not found: ${claim.path}`)
    collectNumbers(selected, values, units)
  }

  if (values.length === 0) throw new Error(`no finite numeric value found in ${source}`)
  return { values, units, evidence: path }
}

function toleranceFor(value: number, claim: VerifyClaim): number {
  if (typeof claim.tolerance === "number" && Number.isFinite(claim.tolerance) && claim.tolerance >= 0) {
    return claim.tolerance
  }
  return Math.max(1e-9, Math.abs(value) * 1e-6)
}

async function checkNumber(
  claim: VerifyClaim,
  index: number,
  options: VerifyOptions,
  issues: VerifyIssue[],
  evidence: string[],
  knownValues: number[],
): Promise<void> {
  if (typeof claim.value !== "number" || !Number.isFinite(claim.value)) {
    issues.push({ type: "number", severity: "error", detail: "number claim requires a finite value", claim: index })
    return
  }
  const expected = claim.value
  knownValues.push(expected)
  if (!claim.source) {
    issues.push({ type: "number", severity: "error", detail: "number claim requires source", claim: index })
    return
  }
  try {
    const source = await readNumberSource(claim.source, claim, options)
    uniquePush(evidence, source.evidence)
    knownValues.push(...source.values)
    const tolerance = toleranceFor(expected, claim)
    const match = source.values.find((value) => Math.abs(value - expected) <= tolerance)
    if (match === undefined) {
      const sample = source.values.slice(0, 5).map(formatValue).join(", ")
      issues.push({
        type: "metric",
        severity: "error",
        detail:
          `number ${formatValue(expected)} not found in ${claim.source}` +
          `${claim.path ? ` at ${claim.path}` : ""}; values: ${sample}`,
        claim: index,
      })
    }

    if (claim.unit) {
      const expected = normalizeUnit(claim.unit)
      if (source.units.length > 0) {
        if (!source.units.some((unit) => normalizeUnit(unit) === expected)) {
          issues.push({
            type: "unit",
            severity: "error",
            detail: `unit mismatch: expected ${claim.unit}, source records ${source.units.join(", ")}`,
            claim: index,
          })
        }
      } else if (claim.requireUnit) {
        issues.push({
          type: "unit",
          severity: "error",
          detail: `source does not record a unit; cannot verify ${claim.unit}`,
          claim: index,
        })
      } else {
        issues.push({
          type: "unit",
          severity: "warning",
          detail: `source does not record a unit; ${claim.unit} is unverified`,
          claim: index,
        })
      }
    }
  } catch (error) {
    issues.push({ type: "metric", severity: "error", detail: messageOf(error), claim: index })
  }
}

interface UrlStatus {
  status?: number
  error?: string
}

async function fetchStatus(url: string, options: VerifyOptions): Promise<UrlStatus> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_CITATION_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal })
    } catch {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: { range: "bytes=0-0" },
        signal: controller.signal,
      })
    }
    if (response.status === 400 || response.status === 403 || response.status === 405) {
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "follow",
          headers: { range: "bytes=0-0" },
          signal: controller.signal,
        })
      } catch {
        // Keep the original response status.
      }
    }
    return { status: response.status }
  } catch (error) {
    return { error: messageOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkCitation(
  claim: VerifyClaim,
  index: number,
  options: VerifyOptions,
  input: VerifyInput,
  issues: VerifyIssue[],
  evidence: string[],
  knownCitations: string[],
): Promise<void> {
  const source = claim.source?.trim()
  if (!source) {
    issues.push({ type: "citation", severity: "error", detail: "citation claim requires source", claim: index })
    return
  }

  if (looksLikeLocalPath(source)) {
    const path = resolvePath(options.baseDir, source)
    try {
      const info = await stat(path)
      uniquePush(evidence, path)
      knownCitations.push(citationKey(source))
      if (!info.isFile() && !info.isDirectory()) {
        issues.push({ type: "citation", severity: "error", detail: `citation path is not a file: ${source}`, claim: index })
      }
    } catch (error) {
      issues.push({ type: "citation", severity: "error", detail: `citation path not found: ${source}`, claim: index })
    }
    return
  }

  const isUrl = /^(?:https?|ftp):\/\//i.test(source)
  const isDoi = /^(?:doi:|10\.\d{4,9}\/)/i.test(source)
  const isArxiv = /^arxiv:/i.test(source)
  if (!isUrl && !isDoi && !isArxiv) {
    issues.push({
      type: "citation",
      severity: "warning",
      detail: `citation is not machine-verifiable: ${source}`,
      claim: index,
    })
    return
  }

  const url = isDoi || isArxiv ? normalizeCitation(source) : source
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    issues.push({ type: "citation", severity: "error", detail: `invalid citation URL: ${source}`, claim: index })
    return
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    issues.push({ type: "citation", severity: "error", detail: `unsupported citation scheme: ${parsed.protocol}`, claim: index })
    return
  }
  knownCitations.push(citationKey(url))
  const enabled = claim.network ?? input.network ?? options.network ?? true
  if (!enabled) {
    uniquePush(evidence, url)
    issues.push({
      type: "citation",
      severity: "warning",
      detail: `citation not fetched (network disabled): ${url}`,
      claim: index,
    })
    return
  }

  const result = await fetchStatus(parsed.toString(), options)
  if (result.error) {
    uniquePush(evidence, url)
    issues.push({
      type: "citation",
      severity: "warning",
      detail: `citation unreachable: ${url} (${result.error})`,
      claim: index,
    })
    return
  }
  if (result.status === undefined) {
    uniquePush(evidence, url)
    issues.push({ type: "citation", severity: "warning", detail: `citation status unknown: ${url}`, claim: index })
    return
  }
  uniquePush(evidence, `${url} (HTTP ${result.status})`)
  if (result.status >= 200 && result.status < 400) return
  if (result.status === 404 || result.status === 410) {
    issues.push({
      type: "citation",
      severity: "error",
      detail: `citation does not exist (HTTP ${result.status}): ${url}`,
      claim: index,
    })
    return
  }
  issues.push({
    type: "citation",
    severity: "warning",
    detail: `citation returned HTTP ${result.status}: ${url}`,
    claim: index,
  })
}

async function checkFile(
  claim: VerifyClaim,
  index: number,
  options: VerifyOptions,
  issues: VerifyIssue[],
  evidence: string[],
): Promise<void> {
  if (!claim.source) {
    issues.push({ type: "file", severity: "error", detail: "file claim requires source", claim: index })
    return
  }
  const path = resolvePath(options.baseDir, claim.source)
  try {
    const info = await stat(path)
    uniquePush(evidence, path)
    if (info.isFile() && info.size === 0) {
      issues.push({ type: "file", severity: "warning", detail: `file is empty: ${claim.source}`, claim: index })
    }
  } catch {
    issues.push({ type: "file", severity: "error", detail: `file not found: ${claim.source}`, claim: index })
  }
}

function tCritical(confidence: number, degreesOfFreedom: number): number | undefined {
  const tables: Record<string, number[]> = {
    "0.9": [
      6.314, 2.92, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345,
      1.341, 1.337, 1.333, 1.33, 1.328, 1.325, 1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313,
      1.311, 1.31,
    ],
    "0.95": [
      12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
      2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045,
      2.042,
    ],
    "0.99": [
      63.657, 9.925, 5.841, 4.604, 4.032, 3.707, 3.499, 3.355, 3.25, 3.169, 3.106, 3.055, 3.012, 2.977,
      2.947, 2.921, 2.898, 2.878, 2.861, 2.845, 2.831, 2.819, 2.807, 2.797, 2.787, 2.779, 2.771, 2.763,
      2.756, 2.75,
    ],
  }
  const key = String(confidence)
  const table = tables[key]
  if (!table) return undefined
  if (degreesOfFreedom <= 0) return undefined
  if (degreesOfFreedom <= table.length) return table[degreesOfFreedom - 1]
  return key === "0.9" ? 1.645 : key === "0.99" ? 2.576 : 1.96
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

async function checkExperiment(
  claim: VerifyClaim,
  index: number,
  options: VerifyOptions,
  issues: VerifyIssue[],
  evidence: string[],
  knownValues: number[],
  stats: Record<string, VerifyStats>,
): Promise<void> {
  const ids = [...new Set((claim.ids ?? (claim.source ? [claim.source] : [])).map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) {
    issues.push({ type: "experiment", severity: "error", detail: "experiment claim requires ids", claim: index })
    return
  }

  const experiments: Experiment[] = []
  for (const id of ids) {
    const experiment = await options.experiments.get(id)
    if (!experiment) {
      issues.push({ type: "experiment", severity: "error", detail: `experiment not found: ${id}`, claim: index })
      continue
    }
    experiments.push(experiment)
    uniquePush(evidence, `experiment:${id}`)
    if (experiment.status !== "completed") {
      issues.push({
        type: "experiment",
        severity: "error",
        detail: `experiment ${id} is ${experiment.status}, not completed`,
        claim: index,
      })
    }
  }
  if (experiments.length === 0) return

  const metric = claim.metric?.trim()
  const needsMetric = Boolean(metric || claim.minSeeds || claim.maxStd || claim.ci)
  if (needsMetric && !metric) {
    issues.push({
      type: "experiment",
      severity: "error",
      detail: "metric is required for seed variance or confidence interval checks",
      claim: index,
    })
    return
  }

  const result: VerifyStats = { ids: experiments.map((experiment) => experiment.id) }
  if (metric) {
    result.metric = metric
    const values: number[] = []
    for (const experiment of experiments) {
      const value = experiment.metrics[metric]
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({
          type: "experiment",
          severity: "error",
          detail: `experiment ${experiment.id} has no metric ${metric}`,
          claim: index,
        })
      } else {
        values.push(value)
      }
    }
    result.values = values
    knownValues.push(...values)
    if (values.length > 0) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const std = sampleStd(values)
      result.mean = mean
      result.std = std
      knownValues.push(mean, std, values.length)
      if (typeof claim.maxStd === "number" && std > claim.maxStd) {
        issues.push({
          type: "seed-variance",
          severity: "error",
          detail: `sample std ${formatValue(std)} for ${metric} exceeds ${formatValue(claim.maxStd)}`,
          claim: index,
        })
      }
      if (typeof claim.ci === "number") {
        if (values.length < 2) {
          issues.push({
            type: "confidence-interval",
            severity: "error",
            detail: "confidence interval requires at least two runs",
            claim: index,
          })
        } else {
          const critical = tCritical(claim.ci, values.length - 1)
          if (critical === undefined) {
            issues.push({
              type: "confidence-interval",
              severity: "warning",
              detail: `unsupported confidence ${claim.ci}; use 0.9, 0.95, or 0.99`,
              claim: index,
            })
          } else {
            const margin = critical * (std / Math.sqrt(values.length))
            const interval: [number, number] = [mean - margin, mean + margin]
            result.ci = interval
            knownValues.push(interval[0], interval[1])
            if (typeof claim.maxCiWidth === "number" && interval[1] - interval[0] > claim.maxCiWidth) {
              issues.push({
                type: "confidence-interval",
                severity: "error",
                detail: `CI width ${formatValue(interval[1] - interval[0])} exceeds ${formatValue(claim.maxCiWidth)}`,
                claim: index,
              })
            }
          }
        }
      }
    }
  }

  const seeds = experiments.map((experiment) => experiment.seed).filter((seed): seed is number => seed !== undefined)
  result.seeds = [...new Set(seeds)].sort((a, b) => a - b)
  knownValues.push(...result.seeds, result.seeds.length)
  if (seeds.length < experiments.length) {
    issues.push({
      type: "seed",
      severity: claim.minSeeds && claim.minSeeds > 1 ? "error" : "warning",
      detail: "some experiments do not record a seed",
      claim: index,
    })
  }
  const minSeeds = claim.minSeeds ?? 0
  if (result.seeds.length < minSeeds) {
    issues.push({
      type: "seed",
      severity: "error",
      detail: `found ${result.seeds.length} distinct seeds; need ${minSeeds}`,
      claim: index,
    })
  }

  if (claim.requireBaseline && !claim.baseline) {
    issues.push({ type: "baseline", severity: "error", detail: "baseline is required but missing", claim: index })
  }

  if (claim.baseline) {
    const baseline = await options.experiments.get(claim.baseline)
    if (!baseline) {
      issues.push({ type: "baseline", severity: "error", detail: `baseline experiment not found: ${claim.baseline}`, claim: index })
    } else {
      uniquePush(evidence, `experiment:${baseline.id}`)
      if (baseline.status !== "completed") {
        issues.push({
          type: "baseline",
          severity: "error",
          detail: `baseline ${baseline.id} is ${baseline.status}, not completed`,
          claim: index,
        })
      }
      const candidateHashes = experiments
        .map((experiment) => experiment.datasetHash)
        .filter((hash): hash is string => hash !== undefined)
      const datasetMismatch =
        baseline.datasetHash !== undefined &&
        candidateHashes.some((hash) => hash !== baseline.datasetHash)
      if (datasetMismatch) {
        issues.push({
          type: "baseline",
          severity: "error",
          detail: `dataset hash differs: baseline ${baseline.datasetHash}, candidates ${[...new Set(candidateHashes)].join(", ")}`,
          claim: index,
        })
      } else if (baseline.datasetHash === undefined || candidateHashes.length < experiments.length) {
        issues.push({
          type: "baseline",
          severity: "warning",
          detail: "dataset hash missing on baseline or candidate; fairness is unverified",
          claim: index,
        })
      }

      const configKeys = new Set([
        ...Object.keys(baseline.config),
        ...experiments.flatMap((experiment) => Object.keys(experiment.config)),
      ])
      const differing = [...configKeys].filter((key) => {
        if (key === "seed") return false
        return experiments.some(
          (experiment) => JSON.stringify(experiment.config[key]) !== JSON.stringify(baseline.config[key]),
        )
      })
      if (differing.length > 0) {
        issues.push({
          type: "baseline",
          severity: "warning",
          detail: `config differs from baseline on: ${differing.slice(0, 8).join(", ")}; confirm only the intended variable changed`,
          claim: index,
        })
      }
      if (metric) {
        const baselineValue = baseline.metrics[metric]
        if (typeof baselineValue !== "number" || !Number.isFinite(baselineValue)) {
          issues.push({
            type: "baseline",
            severity: "error",
            detail: `baseline has no metric ${metric}`,
            claim: index,
          })
        } else if (typeof result.mean === "number") {
          result.baseline = baselineValue
          result.delta = result.mean - baselineValue
          result.pct = baselineValue === 0 ? undefined : (result.delta / Math.abs(baselineValue)) * 100
          knownValues.push(baselineValue)
        }
      }
      const baselineSeeds = new Set(
        (await options.experiments.list())
          .filter((experiment) => experiment.hypothesis === baseline.hypothesis)
          .map((experiment) => experiment.seed)
          .filter((seed): seed is number => seed !== undefined),
      )
      if (minSeeds > 1 && baselineSeeds.size < minSeeds) {
        issues.push({
          type: "baseline",
          severity: "warning",
          detail: `baseline group has ${baselineSeeds.size} distinct seeds; need ${minSeeds} for a fair comparison`,
          claim: index,
        })
      }
    }
  }

  stats[`claim:${index}`] = result
}

async function runCodeCheck(path: string, language: string, options: VerifyOptions): Promise<void> {
  if (language === "json") {
    JSON.parse(await readFile(path, "utf8"))
    return
  }
  if (language === "python") {
    await execFileAsync(
      options.pythonPath || process.env.PYTHON || "python3",
      ["-I", "-c", "import sys; p=sys.argv[1]; compile(open(p, encoding='utf-8').read(), p, 'exec')", path],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    )
    return
  }
  if (language === "bash") {
    await execFileAsync("bash", ["-n", path], { timeout: 10_000, maxBuffer: 64 * 1024 })
    return
  }
  if (language === "javascript") {
    await execFileAsync("node", ["--check", path], { timeout: 10_000, maxBuffer: 64 * 1024 })
    return
  }
  throw new Error(`unsupported code language: ${language}`)
}

async function checkCode(
  claim: VerifyClaim,
  index: number,
  options: VerifyOptions,
  issues: VerifyIssue[],
  evidence: string[],
): Promise<void> {
  if (!claim.source) {
    issues.push({ type: "code", severity: "error", detail: "code claim requires source", claim: index })
    return
  }
  const path = resolvePath(options.baseDir, claim.source)
  try {
    await stat(path)
  } catch {
    issues.push({ type: "code", severity: "error", detail: `code file not found: ${claim.source}`, claim: index })
    return
  }
  uniquePush(evidence, path)
  const extension = extname(path).toLowerCase()
  const language =
    claim.language ??
    (extension === ".py"
      ? "python"
      : extension === ".sh" || extension === ".bash"
        ? "bash"
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? "javascript"
          : extension === ".json" || extension === ".ipynb"
            ? "json"
            : undefined)
  if (!language) {
    issues.push({
      type: "code",
      severity: "warning",
      detail: `cannot infer code language for ${claim.source}; use language`,
      claim: index,
    })
    return
  }
  try {
    await runCodeCheck(path, language, options)
  } catch (error) {
    const detail = messageOf(error)
    const unavailable = /ENOENT|not found/i.test(detail)
    issues.push({
      type: "code",
      severity: unavailable ? "warning" : "error",
      detail: `code check failed for ${claim.source}: ${detail.slice(0, 1_000)}`,
      claim: index,
    })
  }
}

interface AnswerClaims {
  numbers: { raw: string; value: number; percent: boolean; index: number }[]
  citations: string[]
  stripped: string
}

function extractAnswerClaims(text: string): AnswerClaims {
  let stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
  const citations: string[] = []
  const citationPatterns = [
    /https?:\/\/[^\s<>"')\]}]+/gi,
    /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi,
    /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?/gi,
  ]
  for (const pattern of citationPatterns) {
    for (const match of stripped.matchAll(pattern)) {
      const value = match[0]
      citations.push(value)
      stripped = stripped.split(value).join(" ")
    }
  }
  stripped = stripped.replace(/\[\d+\]/g, " ")
  stripped = stripped.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, " ")
  const numbers: AnswerClaims["numbers"] = []
  const pattern = /(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w.])/g
  for (const match of stripped.matchAll(pattern)) {
    const raw = match[0]
    const percent = raw.endsWith("%")
    const value = Number(raw.replace(/[%,]/g, ""))
    if (!Number.isFinite(value)) continue
    if (!raw.includes(".") && Math.abs(value) < 10) continue
    if (!raw.includes(".") && Number.isInteger(value) && Math.abs(value) >= 1900 && Math.abs(value) <= 2100) continue
    numbers.push({ raw, value, percent, index: match.index ?? 0 })
  }
  return { numbers, citations, stripped }
}

export function answerHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex")
}

export function hasVerifiableClaims(text: string): boolean {
  const extracted = extractAnswerClaims(text)
  return extracted.numbers.length > 0 || extracted.citations.length > 0
}

function knownMatch(value: number, percent: boolean, known: readonly number[]): boolean {
  if (known.length === 0) return false
  const candidates = percent ? [value, value / 100] : [value]
  return known.some((entry) =>
    candidates.some((candidate) => {
      if (!Number.isFinite(entry)) return false
      const tolerance = Math.max(0.01, Math.abs(entry) * 0.005)
      return Math.abs(entry - candidate) <= tolerance
    }),
  )
}

function scanAnswer(
  answer: string,
  claims: VerifyClaim[],
  knownValues: number[],
  knownCitations: string[],
  strict: boolean,
  issues: VerifyIssue[],
): VerifyResult["answer"] {
  const extracted = extractAnswerClaims(answer)
  let unverifiedNumbers = 0
  let uncheckedCitations = 0
  if (extracted.numbers.length + extracted.citations.length > 0 && claims.length === 0) {
    issues.push({
      type: "missing-claims",
      severity: "error",
      detail: "answer contains verifiable claims but no structured claims were supplied",
    })
  }
  for (const number of extracted.numbers) {
    if (knownMatch(number.value, number.percent, knownValues)) continue
    const start = Math.max(0, number.index - 50)
    const end = Math.min(extracted.stripped.length, number.index + number.raw.length + 50)
    const context = extracted.stripped.slice(start, end).toLowerCase()
    // Conventional thresholds are labels, not measured results.
    if (
      /(?:\bp\s*[<=>]|p-value|p\s*value|significan)/.test(context) &&
      [0.001, 0.01, 0.05, 0.1].includes(number.value)
    ) {
      continue
    }
    if (number.percent && [90, 95, 99].includes(number.value) && /(?:\bci\b|confidence|interval)/.test(context)) {
      continue
    }
    unverifiedNumbers++
    issues.push({
      type: "unverified-number",
      severity: "error",
      detail: `answer number ${number.raw} has no matching evidence (${extracted.stripped.slice(start, end).replace(/\s+/g, " ")})`,
    })
  }
  const known = new Set(knownCitations.map(citationKey))
  for (const citation of extracted.citations) {
    if (known.has(citationKey(citation))) continue
    uncheckedCitations++
    issues.push({
      type: "unchecked-citation",
      severity: strict ? "error" : "warning",
      detail: `answer citation was not checked: ${citation}`,
    })
  }
  return {
    numbers: extracted.numbers.length,
    citations: extracted.citations.length,
    unverifiedNumbers,
    uncheckedCitations,
  }
}

export async function verifyClaims(input: VerifyInput, options: VerifyOptions): Promise<VerifyResult> {
  const claims = Array.isArray(input.claims) ? input.claims : []
  const issues: VerifyIssue[] = []
  const evidence: string[] = []
  const knownValues: number[] = []
  const knownCitations: string[] = []
  const stats: Record<string, VerifyStats> = {}
  const checks = { numbers: 0, citations: 0, files: 0, experiments: 0, code: 0 }

  for (let index = 0; index < claims.length; index++) {
    const claim = claims[index]!
    try {
      switch (claim.type) {
        case "number":
          checks.numbers++
          await checkNumber(claim, index, options, issues, evidence, knownValues)
          break
        case "citation":
          checks.citations++
          await checkCitation(claim, index, options, input, issues, evidence, knownCitations)
          break
        case "file":
          checks.files++
          await checkFile(claim, index, options, issues, evidence)
          break
        case "experiment":
          checks.experiments++
          await checkExperiment(claim, index, options, issues, evidence, knownValues, stats)
          break
        case "code":
          checks.code++
          await checkCode(claim, index, options, issues, evidence)
          break
        default:
          issues.push({
            type: "claim",
            severity: "error",
            detail: `unknown claim type: ${String((claim as { type?: unknown }).type)}`,
            claim: index,
          })
      }
    } catch (error) {
      issues.push({ type: "claim", severity: "error", detail: messageOf(error), claim: index })
    }
  }

  let answerStats: VerifyResult["answer"]
  if (input.answer && input.scanAnswer !== false) {
    answerStats = scanAnswer(input.answer, claims, knownValues, knownCitations, input.strict === true, issues)
  }

  if (input.strict) {
    for (const issue of issues) issue.severity = "error"
  }

  const pass = !issues.some((issue) => issue.severity === "error")
  const result: VerifyResult = {
    pass,
    gate: pass ? "ok" : "rewrite",
    issues: issues.slice(0, MAX_ISSUES),
    evidence: evidence.slice(0, MAX_EVIDENCE),
    checks,
  }
  if (answerStats) result.answer = answerStats
  if (Object.keys(stats).length > 0) result.stats = stats
  return result
}

export function verificationReceiptKey(projectID: string, sessionID: string): string {
  return `verify:${projectID}:${sessionID}`
}

/** Prevent a receipt from a previous user turn from satisfying the gate. */
export async function invalidateVerificationReceipt(
  storage: VerifyStorage,
  projectID: string,
  sessionID: string,
): Promise<void> {
  await storage.set(verificationReceiptKey(projectID, sessionID), { invalidatedAt: new Date().toISOString() })
}

export function isVerificationReceipt(value: unknown): value is VerificationReceipt {
  if (!isRecord(value)) return false
  return (
    typeof value.answerHash === "string" &&
    typeof value.pass === "boolean" &&
    typeof value.issueCount === "number" &&
    typeof value.at === "string"
  )
}

const verifyInputSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Exact final answer text. Numbers and citations in it are scanned against the supplied claims. Provide this to create a verification receipt for the final-answer gate.",
    },
    claims: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["number", "citation", "file", "experiment", "code"] },
          label: { type: "string", description: "Short human-readable label." },
          value: { type: "number", description: "Claimed numeric value (number claims)." },
          source: {
            type: "string",
            description: "JSON/JSONL/CSV path, experiment:<id>, citation URL/DOI/arXiv/path, or code file.",
          },
          path: { type: "string", description: "JSON path, CSV column, or experiment metric name." },
          tolerance: { type: "number", minimum: 0, description: "Absolute numeric tolerance." },
          unit: { type: "string", description: "Expected unit; checked when the source records one." },
          requireUnit: { type: "boolean", description: "Fail when the source does not record a unit." },
          network: { type: "boolean", description: "Fetch this citation URL (defaults to the tool setting)." },
          ids: { type: "array", items: { type: "string" }, description: "Experiment ids for variance/baseline checks." },
          metric: { type: "string", description: "Metric name for experiment checks." },
          minSeeds: { type: "integer", minimum: 1, description: "Minimum distinct seeds." },
          maxStd: { type: "number", minimum: 0, description: "Maximum sample standard deviation." },
          ci: { type: "number", description: "Confidence level, e.g. 0.95." },
          maxCiWidth: { type: "number", minimum: 0, description: "Maximum confidence interval width." },
          baseline: { type: "string", description: "Baseline experiment id." },
          requireBaseline: { type: "boolean", description: "Fail when no baseline is supplied." },
          language: { type: "string", enum: ["python", "bash", "javascript", "json"] },
        },
        required: ["type"],
        additionalProperties: false,
      },
      description: "Structured claims. Every key number, citation, experiment, and code artifact should appear here.",
    },
    strict: { type: "boolean", description: "Promote warnings to errors." },
    scanAnswer: { type: "boolean", description: "Scan answer numbers/citations (default true)." },
    network: { type: "boolean", description: "Fetch citation URLs (default true)." },
  },
  additionalProperties: false,
}

export function createVerifyTools(options: VerifyToolOptions) {
  return [
    {
      name: "verify",
      description:
        "Verify a research answer before delivery. Recomputes numbers from JSON/JSONL/CSV or experiment metrics, checks citations and paths, checks seed variance/CI and baseline fairness, and syntax-checks code. Provide the exact final answer plus structured claims; pass=false means rewrite, and a passing answer creates a receipt used by the final-answer gate.",
      input: verifyInputSchema,
      options: { codemode: false },
      execute: async (input: VerifyInput, context?: unknown) => {
        const result = await verifyClaims(input, options)
        const sessionID =
          isRecord(context) && typeof context.sessionID === "string" && context.sessionID ? context.sessionID : undefined
        let receiptSaved = false
        if (input.answer && options.storage && sessionID) {
          const receipt: VerificationReceipt = {
            answerHash: answerHash(input.answer),
            pass: result.pass,
            issueCount: result.issues.length,
            issues: result.issues.slice(0, 10).map((issue) => `${issue.type}: ${issue.detail}`),
            at: (options.now ?? (() => new Date().toISOString()))(),
          }
          try {
            await options.storage.set(verificationReceiptKey(options.projectID ?? "default", sessionID), receipt)
            receiptSaved = true
          } catch (error) {
            console.warn("[deepseek-research] failed to save verification receipt", error)
          }
        }
        return {
          content: JSON.stringify({ ...result, receiptSaved }, null, 2),
          metadata: {
            pass: result.pass,
            gate: result.gate,
            errors: result.issues.filter((issue) => issue.severity === "error").length,
            warnings: result.issues.filter((issue) => issue.severity === "warning").length,
            receiptSaved,
          },
        }
      },
    },
  ]
}

import { randomUUID } from "node:crypto"
import { finalAssistantText } from "./messages.ts"
import {
  answerHash,
  isVerificationReceipt,
  verificationReceiptKey,
  type VerifyStorage,
} from "./verify.ts"

export interface BestOfNSession {
  create(input: {
    parentID: string
    title?: string
    agent?: string
    model?: unknown
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }>
  get?(input: { sessionID: string }): Promise<unknown>
  prompt(input: {
    sessionID: string
    text: string
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
    resume?: boolean
  }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<unknown>
  context(input: { sessionID: string }): Promise<unknown>
  interrupt?(input: { sessionID: string }): Promise<unknown>
  synthetic?(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
    resume?: boolean
  }): Promise<unknown>
}

export interface BestOfNOptions {
  session: BestOfNSession
  storage?: VerifyStorage
  projectID: string
  maxCandidates?: number
  timeoutSec?: number
  judge?: boolean
  judgeTimeoutSec?: number
  now?: () => string
  warn?: (message: string, error?: unknown) => void
  background?: boolean
  notify?: boolean
  runID?: string
  onCandidate?: (candidate: BestOfNCandidate) => void
  onJudge?: (judge: BestOfNJudge) => void
}

export interface BestOfNInput {
  task: string
  n?: number
  agent?: string
  judge?: boolean
  judgeAgent?: string
  rubric?: string[]
  timeoutSec?: number
  maxAnswerChars?: number
  background?: boolean
}

export interface BestOfNCandidate {
  index: number
  sessionID?: string
  status: "completed" | "failed" | "timeout" | "no-answer"
  answer?: string
  verified: boolean
  chars: number
  error?: string
}

export interface BestOfNJudge {
  ok: boolean
  sessionID?: string
  skipped?: boolean
  best?: number
  ranking?: Array<{ candidate: number; rank: number; reason: string }>
  disagreements?: string[]
  error?: string
}

export interface BestOfNResult {
  ok: boolean
  runID: string
  task?: string
  n?: number
  best?: {
    index: number
    sessionID: string
    answer: string
    answerTruncated: boolean
    verified: boolean
    basis: "judge" | "verified-first" | "first-completed"
  }
  candidates?: Array<{
    index: number
    sessionID?: string
    status: BestOfNCandidate["status"]
    verified: boolean
    chars: number
    answerPreview?: string
    error?: string
  }>
  judge?: BestOfNJudge
  disagreements?: string[]
  elapsedMs: number
  error?: string
  costHint?: string
}

const DEFAULT_RUBRIC = [
  "correctness and factual accuracy",
  "quality and traceability of evidence",
  "calibration of uncertainty",
  "reproducibility of the described steps",
  "clarity of the final answer",
]

const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_TIMEOUT_SEC = 600
const DEFAULT_JUDGE_TIMEOUT_SEC = 180
const DEFAULT_MAX_ANSWER_CHARS = 20_000
const CANDIDATE_PREVIEW_CHARS = 800

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, Math.max(0, limit)), truncated: true }
}

function preview(value: string): string {
  return truncate(value, CANDIDATE_PREVIEW_CHARS).text
}

function candidatePrompt(task: string, index: number, count: number): string {
  return `You are independent candidate ${index} of ${count} in a Best-of-N research run.
Solve the task independently. Do not assume that other candidates exist or coordinate with them.
If you state a number, citation, experiment result, or code artifact, verify it first with the verify tool; if evidence is missing, write "insufficient evidence".
Return a final answer with: conclusion, evidence, uncertainty, and reproducible steps.
Task:
${task}`
}

function judgePrompt(task: string, candidates: BestOfNCandidate[], rubric: string[]): string {
  const blocks = candidates.map((candidate) => {
    const body = truncate(candidate.answer ?? "", 12_000)
    return `--- candidate ${candidate.index} (verified=${candidate.verified ? "true" : "false"}${body.truncated ? ", truncated" : ""}) ---\n${body.text}`
  })
  return `You are the independent judge for a Best-of-N research run. Do not solve the task yourself.
Task:
${task}

Rubric, in priority order:
${rubric.map((item, index) => `${index + 1}. ${item}`).join("\n")}

Candidate answers:
${blocks.join("\n\n")}

Return ONLY one JSON object, no markdown:
{"best": <candidate number shown above>, "ranking": [{"candidate": <candidate number>, "rank": 1, "reason": "..."}], "disagreements": ["..."]}
Use only the candidate numbers shown above. Do not use numeric scores. Prefer correctness and evidence over style.`
}

function parseJudge(text: string, validCandidates: number[]): {
  best: number
  ranking: Array<{ candidate: number; rank: number; reason: string }>
  disagreements: string[]
} {
  const valid = new Set(validCandidates)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced?.[1] ?? text
  const start = source.indexOf("{")
  const end = source.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("judge did not return JSON")
  const parsed: unknown = JSON.parse(source.slice(start, end + 1))
  if (!isRecord(parsed)) throw new Error("judge JSON is not an object")
  const best = Number(parsed.best)
  if (!Number.isInteger(best) || !valid.has(best)) throw new Error(`judge best is invalid: ${String(parsed.best)}`)

  const ranking: Array<{ candidate: number; rank: number; reason: string }> = []
  if (Array.isArray(parsed.ranking)) {
    const seen = new Set<number>()
    for (const entry of parsed.ranking) {
      if (!isRecord(entry)) continue
      const candidate = Number(entry.candidate)
      const rank = Number(entry.rank)
      if (!Number.isInteger(candidate) || !valid.has(candidate) || seen.has(candidate)) continue
      if (!Number.isInteger(rank) || rank < 1) continue
      seen.add(candidate)
      ranking.push({
        candidate,
        rank,
        reason: typeof entry.reason === "string" ? entry.reason.slice(0, 1_000) : "",
      })
    }
    ranking.sort((a, b) => a.rank - b.rank)
  }

  const disagreements = Array.isArray(parsed.disagreements)
    ? parsed.disagreements
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 20)
        .map((entry) => entry.slice(0, 1_000))
    : []
  return { best, ranking, disagreements }
}

type Timed<T> = { ok: true; value: T } | { ok: false; timeout: true }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true }), Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function verifiedAnswer(
  storage: VerifyStorage | undefined,
  projectID: string,
  sessionID: string,
  answer: string,
): Promise<boolean> {
  if (!storage) return false
  try {
    const receipt = await storage.get(verificationReceiptKey(projectID, sessionID))
    return isVerificationReceipt(receipt) && receipt.pass && receipt.answerHash === answerHash(answer)
  } catch {
    return false
  }
}

interface ParentInfo {
  agent?: string
  model?: unknown
}

async function parentInfo(session: BestOfNSession, parentID: string): Promise<ParentInfo> {
  if (!session.get) return {}
  try {
    const info = await session.get({ sessionID: parentID })
    if (!isRecord(info)) return {}
    return {
      ...(typeof info.agent === "string" ? { agent: info.agent } : {}),
      ...(isRecord(info.model) ? { model: info.model } : {}),
    }
  } catch {
    return {}
  }
}

async function createChild(
  session: BestOfNSession,
  parentID: string,
  title: string,
  metadata: Record<string, unknown>,
  agent: string | undefined,
  model: unknown,
): Promise<{ id: string }> {
  const input = {
    parentID,
    title,
    metadata,
    ...(agent ? { agent } : {}),
    ...(model === undefined ? {} : { model }),
  }
  try {
    return await session.create(input)
  } catch (error) {
    // A configured agent may be primary-only or a model override may be
    // unavailable. Retrying with only the parent link still gives an
    // independent child context using the project defaults.
    if (agent === undefined && model === undefined) throw error
    return session.create({ parentID, title, metadata })
  }
}

async function runCandidate(
  index: number,
  count: number,
  input: BestOfNInput,
  options: BestOfNOptions,
  parentID: string,
  parent: ParentInfo,
  runID: string,
): Promise<BestOfNCandidate> {
  const agent = input.agent ?? parent.agent
  let child: { id: string }
  try {
    child = await createChild(
      options.session,
      parentID,
      `Best-of-N ${runID} candidate ${index}`,
      { source: "best-of-n", role: "candidate", runID, index },
      agent,
      parent.model,
    )
  } catch (error) {
    return { index, status: "failed", verified: false, chars: 0, error: `could not create candidate: ${messageOf(error)}` }
  }

  const sessionID = child.id
  const timeoutMs = clamp(input.timeoutSec ?? options.timeoutSec, DEFAULT_TIMEOUT_SEC, 30, 3_600) * 1_000
  const work = (async () => {
    await options.session.prompt({
      sessionID,
      text: candidatePrompt(input.task, index, count),
      metadata: { source: "best-of-n", role: "candidate", runID, index },
    })
    await options.session.wait({ sessionID })
  })()

  let timed: Timed<void>
  try {
    timed = await withTimeout(work, timeoutMs)
  } catch (error) {
    return { index, sessionID, status: "failed", verified: false, chars: 0, error: messageOf(error) }
  }
  if (!timed.ok) {
    try {
      await options.session.interrupt?.({ sessionID })
    } catch {
      // Best effort; the tool still reports the timeout.
    }
    return { index, sessionID, status: "timeout", verified: false, chars: 0, error: `timed out after ${timeoutMs / 1_000}s` }
  }

  let answer: string | undefined
  try {
    answer = finalAssistantText(await options.session.context({ sessionID }))
  } catch (error) {
    return { index, sessionID, status: "failed", verified: false, chars: 0, error: messageOf(error) }
  }
  if (!answer) {
    return { index, sessionID, status: "no-answer", verified: false, chars: 0, error: "no final assistant text" }
  }
  const verified = await verifiedAnswer(options.storage, options.projectID, sessionID, answer)
  return { index, sessionID, status: "completed", answer, verified, chars: answer.length }
}

async function runJudge(
  input: BestOfNInput,
  options: BestOfNOptions,
  parentID: string,
  parent: ParentInfo,
  runID: string,
  candidates: BestOfNCandidate[],
): Promise<BestOfNJudge> {
  if (input.judge === false || options.judge === false) return { ok: false, skipped: true }
  if (candidates.length < 2) return { ok: false, skipped: true, error: "need at least two completed candidates" }

  const rubric = (input.rubric ?? DEFAULT_RUBRIC)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8)
  const agent = input.judgeAgent ?? parent.agent
  let child: { id: string }
  try {
    child = await createChild(
      options.session,
      parentID,
      `Best-of-N ${runID} judge`,
      { source: "best-of-n", role: "judge", runID },
      agent,
      parent.model,
    )
  } catch (error) {
    return { ok: false, error: `could not create judge: ${messageOf(error)}` }
  }

  const sessionID = child.id
  const timeoutMs = clamp(options.judgeTimeoutSec, DEFAULT_JUDGE_TIMEOUT_SEC, 30, 1_800) * 1_000
  const work = (async () => {
    await options.session.prompt({
      sessionID,
      text: judgePrompt(input.task, candidates, rubric.length > 0 ? rubric : DEFAULT_RUBRIC),
      metadata: { source: "best-of-n", role: "judge", runID },
    })
    await options.session.wait({ sessionID })
  })()
  let timed: Timed<void>
  try {
    timed = await withTimeout(work, timeoutMs)
  } catch (error) {
    return { ok: false, sessionID, error: messageOf(error) }
  }
  if (!timed.ok) {
    try {
      await options.session.interrupt?.({ sessionID })
    } catch {
      // Best effort.
    }
    return { ok: false, sessionID, error: `judge timed out after ${timeoutMs / 1_000}s` }
  }

  let text: string | undefined
  try {
    text = finalAssistantText(await options.session.context({ sessionID }))
  } catch (error) {
    return { ok: false, sessionID, error: messageOf(error) }
  }
  if (!text) return { ok: false, sessionID, error: "judge returned no text" }
  try {
    const parsed = parseJudge(
      text,
      candidates.map((candidate) => candidate.index),
    )
    return {
      ok: true,
      sessionID,
      best: parsed.best,
      ranking: parsed.ranking,
      disagreements: parsed.disagreements,
    }
  } catch (error) {
    return { ok: false, sessionID, error: messageOf(error) }
  }
}

export async function runBestOfN(
  input: BestOfNInput,
  options: BestOfNOptions,
  parentID: string,
): Promise<BestOfNResult> {
  const started = Date.now()
  const runID = options.runID ?? `bon_${randomUUID().slice(0, 8)}`
  const task = typeof input.task === "string" ? input.task.trim() : ""
  if (!task) return { ok: false, runID, elapsedMs: 0, error: "task is required" }

  const maxCandidates = Math.max(3, Math.min(DEFAULT_MAX_CANDIDATES, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)))
  const n = clamp(input.n, 3, 3, maxCandidates)
  const parent = await parentInfo(options.session, parentID)
  const candidates = await Promise.all(
    Array.from({ length: n }, (_, offset) =>
      runCandidate(offset + 1, n, input, options, parentID, parent, runID).then((candidate) => {
        try {
          options.onCandidate?.(candidate)
        } catch {
          // Progress callbacks must not break the run.
        }
        return candidate
      }),
    ),
  )
  const completed = candidates.filter((candidate) => candidate.status === "completed" && candidate.answer)

  let judge: BestOfNJudge | undefined
  if (completed.length >= 2) {
    judge = await runJudge(input, options, parentID, parent, runID, completed)
    try {
      options.onJudge?.(judge)
    } catch {
      // Progress callbacks must not break the run.
    }
  }

  let best: BestOfNCandidate | undefined
  let basis: "judge" | "verified-first" | "first-completed" = "first-completed"
  if (judge?.ok && judge.best !== undefined) {
    best = completed.find((candidate) => candidate.index === judge.best)
    if (best) basis = "judge"
  }
  if (!best) {
    const ranked = [...completed].sort(
      (a, b) => Number(b.verified) - Number(a.verified) || a.index - b.index,
    )
    best = ranked[0]
    if (best) basis = best.verified ? "verified-first" : "first-completed"
  }

  if (!best) {
    const result: BestOfNResult = {
      ok: false,
      runID,
      task,
      n,
      candidates: candidates.map((candidate) => ({
        index: candidate.index,
        ...(candidate.sessionID ? { sessionID: candidate.sessionID } : {}),
        status: candidate.status,
        verified: candidate.verified,
        chars: candidate.chars,
        ...(candidate.error ? { error: candidate.error } : {}),
      })),
      ...(judge ? { judge } : {}),
      elapsedMs: Date.now() - started,
      error: "no candidate produced a final answer",
      costHint: `${n} candidate runs${judge ? " + judge" : ""}`,
    }
    await saveRun(options, runID, result, candidates)
    return result
  }

  const maxAnswerChars = clamp(input.maxAnswerChars, DEFAULT_MAX_ANSWER_CHARS, 1_000, 60_000)
  const bestAnswer = truncate(best.answer ?? "", maxAnswerChars)
  const result: BestOfNResult = {
    ok: true,
    runID,
    task,
    n,
    best: {
      index: best.index,
      sessionID: best.sessionID!,
      answer: bestAnswer.text,
      answerTruncated: bestAnswer.truncated,
      verified: best.verified,
      basis,
    },
    candidates: candidates.map((candidate) => ({
      index: candidate.index,
      ...(candidate.sessionID ? { sessionID: candidate.sessionID } : {}),
      status: candidate.status,
      verified: candidate.verified,
      chars: candidate.chars,
      ...(candidate.answer ? { answerPreview: preview(candidate.answer) } : {}),
      ...(candidate.error ? { error: candidate.error } : {}),
    })),
    ...(judge ? { judge } : {}),
    disagreements: judge?.disagreements ?? [],
    elapsedMs: Date.now() - started,
    costHint: `${n} candidate runs${judge && !judge.skipped ? " + judge" : ""}`,
  }
  await saveRun(options, runID, result, candidates)
  return result
}

async function saveRun(
  options: BestOfNOptions,
  runID: string,
  result: BestOfNResult,
  candidates: BestOfNCandidate[],
): Promise<void> {
  if (!options.storage) return
  try {
    await options.storage.set(`bestofn:${options.projectID}:${runID}`, {
      ...result,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        answer: candidate.answer === undefined ? undefined : truncate(candidate.answer, 60_000).text,
      })),
    })
  } catch (error) {
    ;(options.warn ?? ((message, cause) => console.warn(message, cause)))(
      `[deepseek-research] failed to save best-of-N run ${runID}`,
      error,
    )
  }
}

export type BestOfNBackgroundStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"

export interface BestOfNBackgroundRun {
  runID: string
  parentID: string
  status: BestOfNBackgroundStatus
  task: string
  n: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  instanceID: string
  candidates?: BestOfNResult["candidates"]
  judge?: BestOfNJudge
  result?: BestOfNResult
  error?: string
}

export interface BestOfNBackgroundManager {
  start(input: BestOfNInput, parentID: string): Promise<BestOfNBackgroundRun>
  status(runID: string): Promise<BestOfNBackgroundRun>
  cancel(runID: string): Promise<BestOfNBackgroundRun>
  close(): Promise<void>
}

interface ActiveRun {
  run: BestOfNBackgroundRun
  childIDs: Set<string>
  cancelled: boolean
  closed: boolean
}

function backgroundKey(projectID: string, runID: string): string {
  return `bestofn-bg:${projectID}:${runID}`
}

function candidateSummary(candidate: BestOfNCandidate): NonNullable<BestOfNResult["candidates"]>[number] {
  return {
    index: candidate.index,
    ...(candidate.sessionID ? { sessionID: candidate.sessionID } : {}),
    status: candidate.status,
    verified: candidate.verified,
    chars: candidate.chars,
    ...(candidate.answer ? { answerPreview: preview(candidate.answer) } : {}),
    ...(candidate.error ? { error: candidate.error } : {}),
  }
}

export function createBestOfNBackgroundManager(options: BestOfNOptions): BestOfNBackgroundManager {
  const instanceID = randomUUID()
  const now = options.now ?? (() => new Date().toISOString())
  const warn = options.warn ?? ((message, error) => console.warn(message, error))
  const active = new Map<string, ActiveRun>()
  const memory = new Map<string, BestOfNBackgroundRun>()

  async function read(runID: string): Promise<BestOfNBackgroundRun | undefined> {
    if (options.storage) {
      try {
        const value = await options.storage.get(backgroundKey(options.projectID, runID))
        if (value && typeof value === "object") return value as BestOfNBackgroundRun
      } catch (error) {
        warn(`[deepseek-research] failed to read background Best-of-N run ${runID}`, error)
      }
    }
    return memory.get(runID)
  }

  async function write(run: BestOfNBackgroundRun): Promise<void> {
    run.updatedAt = now()
    memory.set(run.runID, { ...run })
    if (!options.storage) return
    try {
      await options.storage.set(backgroundKey(options.projectID, run.runID), { ...run })
    } catch (error) {
      warn(`[deepseek-research] failed to persist background Best-of-N run ${run.runID}`, error)
    }
  }

  async function notify(run: BestOfNBackgroundRun): Promise<void> {
    if (options.notify === false || !options.session.synthetic || !run.parentID) return
    const state = run.status
    const best = run.result?.best
    const previewText = best?.answer ? truncate(best.answer, 1_200).text : ""
    const lines = [
      `<best-of-n runID="${run.runID}" state="${state}"${best ? ` best="${best.index}"` : ""}>`,
      `task: ${truncate(run.task, 300).text}`,
      ...(run.error ? [`error: ${truncate(run.error, 500).text}`] : []),
      ...(previewText ? ["best answer:", previewText] : []),
      `Use best_of_n_status with runID="${run.runID}" to read the full result.`,
      "</best-of-n>",
    ]
    try {
      await options.session.synthetic({
        sessionID: run.parentID,
        text: lines.join("\n"),
        description: `best-of-n ${run.runID} ${state}`,
        metadata: {
          source: "best-of-n",
          runID: run.runID,
          state,
          ...(best ? { best: best.index } : {}),
        },
        delivery: "queue",
        resume: true,
      })
    } catch (error) {
      warn(`[deepseek-research] failed to notify background Best-of-N run ${run.runID}`, error)
    }
  }

  async function execute(input: BestOfNInput, parentID: string, entry: ActiveRun): Promise<void> {
    const session: BestOfNSession = {
      ...options.session,
      async create(childInput) {
        const child = await options.session.create(childInput)
        entry.childIDs.add(child.id)
        return child
      },
    }
    try {
      const result = await runBestOfN(
        input,
        {
          ...options,
          session,
          runID: entry.run.runID,
          onCandidate(candidate) {
            entry.run.candidates = [
              ...(entry.run.candidates ?? []).filter((item) => item.index !== candidate.index),
              candidateSummary(candidate),
            ].sort((a, b) => a.index - b.index)
            void write(entry.run)
          },
          onJudge(judge) {
            entry.run.judge = judge
            void write(entry.run)
          },
        },
        parentID,
      )
      if (entry.closed) return
      entry.run.status = entry.cancelled ? "cancelled" : result.ok ? "completed" : "failed"
      entry.run.finishedAt = now()
      entry.run.result = result
      entry.run.candidates = result.candidates
      entry.run.judge = result.judge
      if (result.error) entry.run.error = result.error
      await write(entry.run)
      if (!entry.cancelled) await notify(entry.run)
    } catch (error) {
      if (entry.closed) return
      entry.run.status = entry.cancelled ? "cancelled" : "failed"
      entry.run.finishedAt = now()
      entry.run.error = messageOf(error)
      await write(entry.run)
      if (!entry.cancelled) await notify(entry.run)
    } finally {
      active.delete(entry.run.runID)
    }
  }

  async function getStatus(runID: string): Promise<BestOfNBackgroundRun> {
    const run = await read(runID)
    if (!run) throw new Error(`background Best-of-N run not found: ${runID}`)
    if (run.status === "running" && run.instanceID !== instanceID) {
      run.status = "interrupted"
      run.finishedAt = now()
      run.error = "plugin restarted before the background run completed"
      await write(run)
    }
    const current = active.get(runID)
    return current ? { ...current.run } : run
  }

  return {
    async start(input, parentID) {
      const task = typeof input.task === "string" ? input.task.trim() : ""
      if (!task) throw new Error("task is required")
      const maxCandidates = Math.max(
        3,
        Math.min(DEFAULT_MAX_CANDIDATES, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)),
      )
      const n = clamp(input.n, 3, 3, maxCandidates)
      const runID = `bon_${randomUUID().slice(0, 8)}`
      const timestamp = now()
      const run: BestOfNBackgroundRun = {
        runID,
        parentID,
        status: "running",
        task,
        n,
        startedAt: timestamp,
        updatedAt: timestamp,
        instanceID,
      }
      const entry: ActiveRun = { run, childIDs: new Set(), cancelled: false, closed: false }
      active.set(runID, entry)
      await write(run)
      void execute({ ...input, task }, parentID, entry)
      return { ...run }
    },

    status: getStatus,

    async cancel(runID) {
      const run = await getStatus(runID)
      if (run.status !== "running") return run
      run.status = "cancelled"
      run.finishedAt = now()
      run.error = "cancelled by user"
      await write(run)
      const entry = active.get(runID)
      if (entry) {
        entry.cancelled = true
        entry.run.status = "cancelled"
        entry.run.finishedAt = run.finishedAt
        entry.run.error = run.error
        for (const sessionID of entry.childIDs) {
          try {
            await options.session.interrupt?.({ sessionID })
          } catch {
            // Best effort.
          }
        }
      }
      return { ...run }
    },

    async close() {
      for (const entry of active.values()) {
        entry.closed = true
        if (entry.run.status === "running") {
          entry.run.status = "interrupted"
          entry.run.finishedAt = now()
          entry.run.error = "plugin unloaded before the background run completed"
          await write(entry.run)
        }
        for (const sessionID of entry.childIDs) {
          try {
            await options.session.interrupt?.({ sessionID })
          } catch {
            // Best effort.
          }
        }
      }
      active.clear()
    },
  }
}

const bestOfNInputSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "The research task. Each candidate solves it independently in a child session.",
    },
    n: {
      type: "integer",
      minimum: 3,
      maximum: 5,
      description: "Number of independent candidates (default 3).",
    },
    agent: { type: "string", description: "Optional subagent id for candidates; defaults to the parent agent." },
    judge: { type: "boolean", description: "Run a separate judge session (default true)." },
    judgeAgent: { type: "string", description: "Optional subagent id for the judge." },
    rubric: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
      description: "Rubric criteria, highest priority first.",
    },
    timeoutSec: {
      type: "integer",
      minimum: 30,
      maximum: 3_600,
      description: "Per-candidate timeout (default 600s).",
    },
    maxAnswerChars: {
      type: "integer",
      minimum: 1_000,
      maximum: 60_000,
      description: "Maximum best-answer characters returned (default 20000).",
    },
    background: {
      type: "boolean",
      description:
        "Return immediately with a runID instead of waiting. Poll best_of_n_status and use best_of_n_cancel to stop it.",
    },
  },
  required: ["task"],
  additionalProperties: false,
}

export type BestOfNToolSet = Array<{
  name: string
  description: string
  input: Record<string, unknown>
  options: { codemode: false }
  execute: (input: any, context?: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
}> & { close?: () => Promise<void> }

export function createBestOfNTools(options: BestOfNOptions): BestOfNToolSet {
  const manager = options.background === false ? undefined : createBestOfNBackgroundManager(options)
  const tools: BestOfNToolSet = [
    {
      name: "best_of_n",
      description:
        "Run an expensive Best-of-N research pass: N=3-5 independent child sessions solve the same task, then an optional judge ranks them against a rubric and returns the best answer plus disagreements. Set background=true to return immediately with a runID. Each candidate is a full model run, so use only for high-value, verifiable tasks.",
      input: bestOfNInputSchema,
      options: { codemode: false },
      execute: async (input: BestOfNInput, context?: unknown) => {
        const parentID =
          isRecord(context) && typeof context.sessionID === "string" && context.sessionID
            ? context.sessionID
            : undefined
        if (!parentID) {
          const result: BestOfNResult = {
            ok: false,
            runID: "bon_invalid",
            elapsedMs: 0,
            error: "best_of_n requires a tool context with sessionID",
          }
          return { content: JSON.stringify(result, null, 2), metadata: { ok: false, runID: result.runID } }
        }
        if (options.session.get) {
          try {
            const info = await options.session.get({ sessionID: parentID })
            if (isRecord(info) && typeof info.parentID === "string") {
              const result: BestOfNResult = {
                ok: false,
                runID: "bon_child",
                elapsedMs: 0,
                error: "best_of_n can only be launched from a root session; refusing nested Best-of-N",
              }
              return { content: JSON.stringify(result, null, 2), metadata: { ok: false, runID: result.runID } }
            }
          } catch {
            // If the parent lookup fails, let the run proceed and surface the real error.
          }
        }
        if (input.background) {
          if (!manager) {
            return {
              content: JSON.stringify({ ok: false, error: "background Best-of-N is disabled" }, null, 2),
              metadata: { ok: false },
            }
          }
          try {
            const run = await manager.start(input, parentID)
            return {
              content: JSON.stringify(
                {
                  ok: true,
                  runID: run.runID,
                  status: run.status,
                  n: run.n,
                  parentID,
                },
                null,
                2,
              ),
              metadata: { ok: true, runID: run.runID, status: run.status, n: run.n },
            }
          } catch (error) {
            return {
              content: JSON.stringify({ ok: false, error: messageOf(error) }, null, 2),
              metadata: { ok: false },
            }
          }
        }

        const result = await runBestOfN(input, options, parentID)
        return {
          content: JSON.stringify(result, null, 2),
          metadata: {
            ok: result.ok,
            runID: result.runID,
            n: result.n ?? 0,
            best: result.best?.index,
            judge: result.judge?.ok ?? false,
            elapsedMs: result.elapsedMs,
          },
        }
      },
    },
  ]

  if (manager) {
    tools.push({
      name: "best_of_n_status",
      description:
        "Read a background Best-of-N run by runID. Returns running/completed/failed/cancelled/interrupted, candidate progress, judge output, and the full result when finished.",
      input: {
        type: "object",
        properties: { runID: { type: "string", description: "runID returned by best_of_n with background=true." } },
        required: ["runID"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: { runID: string }) => {
        try {
          const run = await manager.status(input.runID)
          return {
            content: JSON.stringify(run, null, 2),
            metadata: {
              runID: run.runID,
              status: run.status,
              n: run.n,
              best: run.result?.best?.index,
            },
          }
        } catch (error) {
          return {
            content: JSON.stringify({ ok: false, error: messageOf(error) }, null, 2),
            metadata: { ok: false, runID: input.runID },
          }
        }
      },
    })
    tools.push({
      name: "best_of_n_cancel",
      description:
        "Cancel a running background Best-of-N run and interrupt its candidate/judge child sessions. Returns the updated run record.",
      input: {
        type: "object",
        properties: { runID: { type: "string", description: "runID returned by best_of_n with background=true." } },
        required: ["runID"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: { runID: string }) => {
        try {
          const run = await manager.cancel(input.runID)
          return {
            content: JSON.stringify(run, null, 2),
            metadata: { runID: run.runID, status: run.status },
          }
        } catch (error) {
          return {
            content: JSON.stringify({ ok: false, error: messageOf(error) }, null, 2),
            metadata: { ok: false, runID: input.runID },
          }
        }
      },
    })
    tools.close = () => manager.close()
  }
  return tools
}

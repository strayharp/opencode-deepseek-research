import { describe, expect, test } from "bun:test"
import {
  createBestOfNTools,
  runBestOfN,
  type BestOfNInput,
  type BestOfNOptions,
} from "../plugin/bestofn.ts"
import { answerHash, verificationReceiptKey } from "../plugin/verify.ts"

interface FakeOptions {
  answers?: Record<number, string>
  judgeText?: string
  failCandidate?: number
  failCandidates?: number[]
  failJudge?: boolean
  judgeDisabled?: boolean
  parentID?: string
  receipts?: Record<string, { answer: string; pass: boolean }>
  waitMs?: number
  notify?: boolean
}

function setup(input: FakeOptions = {}) {
  const data = new Map<string, unknown>()
  const created: any[] = []
  const prompts: any[] = []
  const interrupts: string[] = []
  const synthetics: any[] = []
  const roles = new Map<string, { role: string; index?: number }>()

  const session = {
    async create(options: any) {
      const role = options.metadata?.role ?? "candidate"
      const index = options.metadata?.index
      const id = role === "judge" ? "ses_judge" : `ses_candidate_${index}`
      created.push({ id, ...options })
      roles.set(id, { role, ...(typeof index === "number" ? { index } : {}) })
      return { id }
    },
    async get() {
      return {
        agent: "build",
        model: { providerID: "fake", id: "fake-model" },
        ...(input.parentID ? { parentID: input.parentID } : {}),
      }
    },
    async prompt(options: any) {
      prompts.push(options)
      const info = roles.get(options.sessionID)
      if (
        info?.role === "candidate" &&
        (info.index === input.failCandidate || (input.failCandidates ?? []).includes(info.index ?? 0))
      ) {
        throw new Error("candidate prompt failed")
      }
      if (info?.role === "judge" && input.failJudge) throw new Error("judge prompt failed")
      return { id: "msg_prompt" }
    },
    async wait() {
      if (input.waitMs) await new Promise((resolve) => setTimeout(resolve, input.waitMs))
      return
    },
    async context(options: any) {
      const info = roles.get(options.sessionID)
      if (info?.role === "judge") {
        return [
          {
            type: "assistant",
            content: [
              {
                type: "text",
                text:
                  input.judgeText ??
                  '{"best": 2, "ranking": [{"candidate": 2, "rank": 1, "reason": "best evidence"}, {"candidate": 1, "rank": 2, "reason": "weaker"}], "disagreements": ["candidate 1 and 2 report different accuracies"]}',
              },
            ],
          },
          { type: "idle", outcome: "succeeded" },
        ]
      }
      const answer = input.answers?.[info?.index ?? 0] ?? `candidate ${info?.index ?? 0} answer`
      return [{ type: "assistant", content: [{ type: "text", text: answer }] }, { type: "idle" }]
    },
    async interrupt(options: { sessionID: string }) {
      interrupts.push(options.sessionID)
    },
    async synthetic(options: any) {
      synthetics.push(options)
      return { id: "msg_synthetic" }
    },
  }

  for (const [sessionID, receipt] of Object.entries(input.receipts ?? {})) {
    data.set(verificationReceiptKey("proj_test", sessionID), {
      answerHash: answerHash(receipt.answer),
      pass: receipt.pass,
      issueCount: receipt.pass ? 0 : 1,
      issues: receipt.pass ? [] : ["metric: mismatch"],
      at: "2026-10-23T00:00:00.000Z",
    })
  }

  const storage = {
    async get(key: string) {
      return data.get(key)
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
  }

  const options: BestOfNOptions = {
    session: session as any,
    storage,
    projectID: "proj_test",
    maxCandidates: 5,
    timeoutSec: 600,
    judge: !input.judgeDisabled,
    judgeTimeoutSec: 180,
    notify: input.notify ?? false,
    now: () => "2026-10-23T00:00:00.000Z",
    warn: () => {},
  }
  return { options, data, created, prompts, interrupts, synthetics, session }
}

const baseInput: BestOfNInput = { task: "Compare two methods and recommend one." }

describe("best-of-N orchestration", () => {
  test("runs independent candidates and uses the judge's best answer", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
    })
    const result = await runBestOfN({ ...baseInput, n: 3 }, fake.options, "ses_parent")
    expect(result.ok).toBe(true)
    expect(result.best).toMatchObject({ index: 2, basis: "judge", verified: false })
    expect(result.best!.answer).toContain("73.4%")
    expect(result.candidates).toHaveLength(3)
    expect(result.judge).toMatchObject({ ok: true, best: 2 })
    expect(result.disagreements).toHaveLength(1)
    expect(fake.created).toHaveLength(4)
    expect(fake.created.filter((item) => item.metadata.role === "candidate")).toHaveLength(3)
    expect(fake.created.find((item) => item.metadata.role === "judge")).toBeDefined()
    expect(fake.prompts.filter((item) => item.metadata.role === "candidate")).toHaveLength(3)
    expect(fake.prompts.some((item) => item.text.includes("candidate 1 of 3"))).toBe(true)
    expect(fake.prompts.some((item) => item.text.includes("independent judge"))).toBe(true)
    const record = [...fake.data.entries()].find(([key]) => key.startsWith("bestofn:proj_test:"))
    expect(record?.[1]).toMatchObject({ ok: true, runID: result.runID })
  })

  test("falls back to a verified candidate when the judge is disabled", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
      receipts: { ses_candidate_2: { answer: "candidate two says 73.4%", pass: true } },
    })
    const result = await runBestOfN({ ...baseInput, n: 3, judge: false }, fake.options, "ses_parent")
    expect(result.ok).toBe(true)
    expect(result.best).toMatchObject({ index: 2, basis: "verified-first", verified: true })
    expect(result.judge).toMatchObject({ ok: false, skipped: true })
    expect(fake.created).toHaveLength(3)
  })

  test("keeps completed candidates when one candidate fails", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
      failCandidate: 1,
    })
    const result = await runBestOfN({ ...baseInput, n: 3 }, fake.options, "ses_parent")
    expect(result.ok).toBe(true)
    expect(result.candidates?.find((candidate) => candidate.index === 1)?.status).toBe("failed")
    expect(result.best?.index).toBe(2)
    expect(fake.created.filter((item) => item.metadata.role === "candidate")).toHaveLength(3)
  })

  test("falls back when the judge picks a candidate that failed", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
      failCandidate: 2,
    })
    const result = await runBestOfN({ ...baseInput, n: 3 }, fake.options, "ses_parent")
    expect(result.ok).toBe(true)
    expect(result.judge).toMatchObject({ ok: false })
    expect(result.best?.index).toBe(1)
    expect(result.best?.basis).toBe("first-completed")
  })

  test("falls back deterministically when the judge JSON is invalid", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
      judgeText: "I think candidate 2 is best, but this is not JSON.",
    })
    const result = await runBestOfN({ ...baseInput, n: 3 }, fake.options, "ses_parent")
    expect(result.ok).toBe(true)
    expect(result.judge).toMatchObject({ ok: false })
    expect(result.best?.index).toBe(1)
    expect(result.best?.basis).toBe("first-completed")
  })

  test("returns a structured error when no candidate produces an answer", async () => {
    const fake = setup({ failCandidates: [1, 2, 3] })
    const result = await runBestOfN({ task: "Do something", n: 3 }, fake.options, "ses_parent")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no candidate")
    expect(result.candidates?.every((candidate) => candidate.status === "failed")).toBe(true)
    expect(fake.created.filter((item) => item.metadata.role === "judge")).toHaveLength(0)
  })

  test("returns a tool error without a session context", async () => {
    const fake = setup()
    const tool = createBestOfNTools(fake.options)[0]!
    const result = await tool.execute({ task: "test" }, {})
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("sessionID")
  })

  test("refuses nested Best-of-N from a child session", async () => {
    const fake = setup({ parentID: "ses_parent" })
    const tool = createBestOfNTools(fake.options)[0]!
    const result = await tool.execute({ task: "test" }, { sessionID: "ses_child" })
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("root session")
    expect(fake.created).toHaveLength(0)
  })

  test("starts a background run, reports progress, and notifies on completion", async () => {
    const fake = setup({
      answers: { 1: "candidate one says 71.0%", 2: "candidate two says 73.4%", 3: "candidate three says 72.1%" },
      notify: true,
    })
    const tools = createBestOfNTools({ ...fake.options, background: true, notify: true })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect([...byName.keys()].sort()).toEqual(["best_of_n", "best_of_n_cancel", "best_of_n_status"])

    const start = await byName.get("best_of_n")!.execute(
      { ...baseInput, n: 3, background: true },
      { sessionID: "ses_parent" },
    )
    expect(start.metadata).toMatchObject({ ok: true, status: "running", n: 3 })
    const runID = String(start.metadata.runID)

    let run: any
    for (let i = 0; i < 100; i += 1) {
      const response = await byName.get("best_of_n_status")!.execute({ runID })
      run = JSON.parse(response.content)
      if (run.status !== "running") break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(run.status).toBe("completed")
    expect(run.result.best.index).toBe(2)
    expect(fake.synthetics).toHaveLength(1)
    expect(fake.synthetics[0]!.text).toContain("best-of-n")
    await tools.close?.()
  })

  test("cancels a background run and interrupts child sessions", async () => {
    const fake = setup({
      answers: { 1: "candidate one", 2: "candidate two", 3: "candidate three" },
      waitMs: 100,
    })
    const tools = createBestOfNTools({ ...fake.options, background: true })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const start = await byName.get("best_of_n")!.execute(
      { ...baseInput, n: 3, background: true },
      { sessionID: "ses_parent" },
    )
    const runID = String(start.metadata.runID)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cancelled = await byName.get("best_of_n_cancel")!.execute({ runID })
    expect(cancelled.metadata.status).toBe("cancelled")
    expect(fake.interrupts.length).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const status = JSON.parse((await byName.get("best_of_n_status")!.execute({ runID })).content)
    expect(status.status).toBe("cancelled")
    await tools.close?.()
  })
})

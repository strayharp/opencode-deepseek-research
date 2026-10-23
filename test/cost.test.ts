import { describe, expect, test } from "bun:test"
import {
  budgetNotice,
  createCostReportTool,
  createCostTracker,
  emptyTokens,
  formatCostReport,
  totalTokens,
  type CostEvent,
  type CostStorage,
} from "../plugin/cost.ts"

function storage(): CostStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...data.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
      const page = keys.slice(0, limit)
      return {
        entries: page.map((key) => ({ key, value: data.get(key) })),
        ...(keys.length > limit ? { next: page[page.length - 1] } : {}),
      }
    },
  }
}

const fixedNow = new Date("2026-10-23T12:00:00.000Z")
const now = () => fixedNow

function tokens(input = 1_000, output = 100, read = 0) {
  return { input, output, reasoning: 0, cache: { read, write: 0 } }
}

async function step(
  tracker: ReturnType<typeof createCostTracker>,
  id: string,
  sessionID: string,
  agent: string,
  model: { providerID: string; id: string },
  cost: number,
  usage = tokens(),
) {
  await tracker.handle({
    type: "session.step.started",
    data: { sessionID, assistantMessageID: id, agent, model },
  })
  await tracker.handle({
    type: "session.step.ended",
    data: { sessionID, assistantMessageID: id, cost, tokens: usage },
  })
  await tracker.handle({
    type: "session.usage.updated",
    data: { sessionID, cost, tokens: usage },
  })
}

describe("cost tracker", () => {
  test("aggregates a task, its child sessions, agents, and models", async () => {
    const store = storage()
    const tracker = createCostTracker({ storage: store, projectID: "proj", now })
    await tracker.load()
    await tracker.handle({
      type: "session.created",
      data: { sessionID: "ses_root", title: "Root task" },
    })
    await step(tracker, "msg_root", "ses_root", "scout", { providerID: "deepseek", id: "flash" }, 0.002)
    await tracker.handle({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_root", title: "Child task" },
    })
    await step(tracker, "msg_child", "ses_child", "analyst", { providerID: "deepseek", id: "flash" }, 0.003)

    const task = await tracker.report({ groupBy: "task" })
    expect(task.totalCost).toBeCloseTo(0.005, 8)
    expect(task.sessions).toBe(2)
    expect(task.groups).toHaveLength(1)
    expect(task.groups[0]).toMatchObject({ key: "ses_root", label: "Root task", sessions: 2 })
    expect(task.groups[0]!.cost).toBeCloseTo(0.005, 8)
    expect(totalTokens(task.tokens)).toBe(2_200)
    expect(task.unattributedCost).toBe(0)

    const agent = await tracker.report({ groupBy: "agent" })
    expect(agent.groups.map((group) => group.key)).toEqual(["analyst", "scout"])
    expect(agent.groups.reduce((sum, group) => sum + group.cost, 0)).toBeCloseTo(0.005, 8)

    const model = await tracker.report({ groupBy: "model" })
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0]!.key).toBe("deepseek/flash")

    const session = await tracker.report({ groupBy: "session" })
    expect(session.groups).toHaveLength(2)
    expect(session.groups.map((group) => group.key).sort()).toEqual(["ses_child", "ses_root"])
  })

  test("records auxiliary title/compaction usage without double counting", async () => {
    const store = storage()
    const tracker = createCostTracker({ storage: store, projectID: "proj", now })
    await tracker.load()
    await tracker.handle({ type: "session.created", data: { sessionID: "ses_1", title: "Task" } })
    await tracker.handle({
      type: "session.usage.recorded",
      data: { sessionID: "ses_1", source: "compaction", cost: 0.001, tokens: tokens(500, 20) },
    })
    await tracker.handle({
      type: "session.usage.updated",
      data: { sessionID: "ses_1", cost: 0.006, tokens: tokens(3_000, 200) },
    })
    const report = await tracker.report({ groupBy: "agent" })
    expect(report.totalCost).toBeCloseTo(0.006, 8)
    expect(report.groups.find((group) => group.key === "aux:compaction")?.cost).toBeCloseTo(0.001, 8)
    expect(report.unattributedCost).toBeCloseTo(0.005, 8)
  })

  test("enforces a USD budget once and blocks the task", async () => {
    const store = storage()
    const exceeded: string[] = []
    const tracker = createCostTracker({
      storage: store,
      projectID: "proj",
      now,
      budgets: { usd: 0.004, scope: "project" },
      onExceeded: ({ sessionID }) => {
        exceeded.push(sessionID ?? "none")
      },
    })
    await tracker.load()
    await tracker.handle({ type: "session.created", data: { sessionID: "ses_1", title: "Task" } })
    await step(tracker, "msg_1", "ses_1", "critic", { providerID: "deepseek", id: "flash" }, 0.005)
    expect(exceeded).toEqual(["ses_1"])
    expect((await tracker.check("ses_1")).exceeded).toBe(true)
    expect(tracker.isBlocked("ses_1")).toBe(true)

    await tracker.handle({
      type: "session.usage.updated",
      data: { sessionID: "ses_1", cost: 0.006, tokens: tokens() },
    })
    expect(exceeded).toEqual(["ses_1"])
    expect(await tracker.enforce("ses_1", await tracker.check("ses_1"))).toBe(false)
  })

  test("a task-scoped budget does not block an unrelated root", async () => {
    const store = storage()
    const exceeded: string[] = []
    const tracker = createCostTracker({
      storage: store,
      projectID: "proj",
      now,
      budgets: { usd: 0.004, scope: "task" },
      onExceeded: ({ sessionID }) => {
        exceeded.push(sessionID ?? "none")
      },
    })
    await tracker.load()
    await tracker.handle({ type: "session.created", data: { sessionID: "ses_a", title: "A" } })
    await tracker.handle({ type: "session.created", data: { sessionID: "ses_b", title: "B" } })
    await step(tracker, "msg_a", "ses_a", "scout", { providerID: "deepseek", id: "flash" }, 0.005)
    expect(exceeded).toEqual(["ses_a"])
    expect(tracker.isBlocked("ses_a")).toBe(true)
    expect(tracker.isBlocked("ses_b")).toBe(false)
    expect((await tracker.check("ses_b")).exceeded).toBe(false)
  })

  test("renders markdown and JSON cost reports", async () => {
    const store = storage()
    const tracker = createCostTracker({ storage: store, projectID: "proj", now })
    await tracker.load()
    await tracker.handle({ type: "session.created", data: { sessionID: "ses_1", title: "Report" } })
    await step(tracker, "msg_1", "ses_1", "writer", { providerID: "deepseek", id: "flash" }, 0.123456)
    const report = await tracker.report({ groupBy: "agent" })
    const markdown = formatCostReport(report)
    expect(markdown).toContain("# DeepSeek Research Cost Report")
    expect(markdown).toContain("writer")
    expect(markdown).toContain("$0.1235")

    const tool = createCostReportTool(tracker)
    const json = await tool.execute({ groupBy: "agent", format: "json" })
    expect(JSON.parse(json.content).totalCost).toBeCloseTo(0.123456, 8)
    expect(json.metadata?.groups).toBe(1)
    const pretty = await tool.execute({ groupBy: "agent" })
    expect(pretty.content).toContain("| Agent |")
    const scoped = await tool.execute({ groupBy: "task" }, { sessionID: "ses_1" })
    expect(scoped.content).toContain("Scope: task ses_1")
  })

  test("formats a budget notice", () => {
    expect(
      budgetNotice({
        limited: true,
        exceeded: true,
        reasons: ["usd"],
        usd: 1.2,
        usdLimit: 1,
        scope: "project",
      }),
    ).toContain("预算守卫")
  })

  test("starts from an empty token bucket", () => {
    expect(totalTokens(emptyTokens())).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import rootPlugin from "../index.ts"
import plugin from "../plugin/index.ts"

type Hook = (event: any) => void | Promise<void>

function mockContext(events: any[] = []) {
  const hooks = new Map<string, Hook>()
  const subscribed: { signal?: AbortSignal }[] = []
  const stored: { key: string; value: unknown }[] = []
  const tools: any[] = []
  const agents: any[] = []
  const skills: any[] = []
  const commands: any[] = []
  const prompts: any[] = []
  const interrupts: any[] = []
  const synthetics: any[] = []
  const data = new Map<string, unknown>()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })

  return {
    hooks,
    subscribed,
    stored,
    tools,
    agents,
    skills,
    commands,
    prompts,
    interrupts,
    synthetics,
    finished,
    ctx: {
      options: {},
      location: { project: { id: "proj_test" }, directory: "/work/project" },
      session: {
        hook: async (name: string, fn: Hook) => {
          hooks.set(name, fn)
          return { dispose: async () => {} }
        },
        prompt: async (input: any) => {
          prompts.push(input)
          return { id: "msg_prompt" }
        },
        switchAgent: async () => {},
        wait: async () => {},
        interrupt: async (input: any) => {
          interrupts.push(input)
          return { interrupted: true }
        },
        synthetic: async (input: any) => {
          synthetics.push(input)
          return { id: "msg_synthetic" }
        },
      },
      agent: {
        get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID, name: agentID } }),
        transform: async (callback: (editor: any) => void) => {
          const map = new Map<string, any>()
          callback({
            get: (id: string) => map.get(id),
            update: (id: string, update: (agent: any) => void) => {
              const agent = map.get(id) ?? { id, name: id, mode: "primary", hidden: false, system: "" }
              update(agent)
              map.set(id, agent)
            },
          })
          agents.push(...map.values())
          return { dispose: async () => {} }
        },
      },
      skill: {
        transform: async (callback: (editor: any) => void) => {
          const map = new Map<string, any>()
          callback({
            get: (id: string) => map.get(id),
            add: (skill: any) => map.set(skill.id, skill),
          })
          skills.push(...map.values())
          return { dispose: async () => {} }
        },
      },
      command: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add: (command: any) => commands.push(command) })
          return { dispose: async () => {} }
        },
      },
      tool: {
        hook: async (name: string, fn: Hook) => {
          hooks.set(`tool:${name}`, fn)
          return { dispose: async () => {} }
        },
        transform: async (callback: (editor: any) => void) => {
          callback({
            add: (tool: any) => tools.push(tool),
            list: () => [],
            get: () => undefined,
            namespace: () => {},
            update: () => {},
            remove: () => {},
          })
          return { dispose: async () => {} }
        },
      },
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          subscribed.push(options ?? {})
          return (async function* () {
            for (const event of events) yield event
            finish()
          })()
        },
      },
      storage: {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => {
          data.set(key, value)
          stored.push({ key, value })
        },
        scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
          const keys = [...data.keys()]
            .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
            .sort()
          const page = keys.slice(0, limit)
          return {
            entries: page.map((key) => ({ key, value: data.get(key) })),
            ...(keys.length > limit ? { next: page[page.length - 1] } : {}),
          }
        },
      },
    },
  }
}

describe("deepseek.research plugin", () => {
  test("root entrypoint re-exports the same plugin", () => {
    expect(rootPlugin).toBe(plugin)
  })

  test("registers hooks, presets, and tools", async () => {
    const { ctx, hooks, subscribed, tools, agents, skills, commands } = mockContext()
    const cleanup = await plugin.setup(ctx as any)
    expect([...hooks.keys()].sort()).toEqual([
      "compaction",
      "context",
      "model.request",
      "tool:execute.after",
      "tool:execute.before",
    ])
    expect(agents.map((agent) => agent.id).sort()).toEqual([
      "analyst",
      "critic",
      "experimenter",
      "scout",
      "writer",
    ])
    expect(agents.every((agent) => agent.mode === "all" && agent.system.length > 50)).toBe(true)
    expect(skills.map((skill) => skill.id).sort()).toEqual([
      "deepseek-experiment-design",
      "deepseek-latex",
      "deepseek-paper-reading",
      "deepseek-rebuttal",
      "deepseek-statistics",
    ])
    expect(commands.map((command) => command.name).sort()).toEqual([
      "ablate",
      "lit",
      "paper",
      "prereg",
      "verify",
    ])
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "best_of_n",
      "best_of_n_cancel",
      "best_of_n_status",
      "cost_report",
      "exp_best",
      "exp_compare",
      "exp_query",
      "exp_record",
      "run_code",
      "verify",
    ])
    expect(subscribed).toHaveLength(1)
    expect(subscribed[0]!.signal).toBeInstanceOf(AbortSignal)
    await cleanup?.()
  })

  test("can disable agent, skill, and command presets independently", async () => {
    const { ctx, agents, skills, commands } = mockContext()
    ctx.options = { agentPresets: false, researchSkills: false, researchCommands: false }
    await plugin.setup(ctx as any)
    expect(agents).toHaveLength(0)
    expect(skills).toHaveLength(0)
    expect(commands).toHaveLength(0)
  })

  test("persists cache stats from usage events", async () => {
    const usage = {
      type: "session.usage.updated",
      data: {
        sessionID: "ses_test",
        tokens: { input: 100_000, output: 100, reasoning: 0, cache: { read: 300_000, write: 0 } },
      },
    }
    const { ctx, stored, finished } = mockContext([usage])
    const cleanup = await plugin.setup(ctx as any)
    await finished

    const cache = stored.find((entry) => entry.key === "deepseek-research:cache:ses_test")
    expect(cache).toBeDefined()
    expect(cache!.value).toMatchObject({ promptTokens: 400_000, cachedTokens: 300_000, hitRate: 0.75 })
    expect(stored.some((entry) => entry.key === "cost:proj_test:ses_test")).toBe(true)
    await cleanup?.()
  })

  test("blocks tools and routes model requests when the USD budget is exceeded", async () => {
    const usage = {
      type: "session.usage.updated",
      data: {
        sessionID: "ses_budget",
        cost: 0.02,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }
    const { ctx, hooks, interrupts, synthetics, finished, stored } = mockContext([usage])
    ctx.options = { budgetUSD: 0.01 }
    const cleanup = await plugin.setup(ctx as any)
    await finished
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(interrupts).toHaveLength(0)
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0]!.text).toContain("预算守卫")
    expect(stored.some((entry) => entry.key === "cost:proj_test:ses_budget")).toBe(true)

    await expect(
      hooks.get("tool:execute.before")!({ tool: "shell", sessionID: "ses_budget" }),
    ).rejects.toThrow("budget exceeded")
    await hooks.get("tool:execute.before")!({ tool: "cost_report", sessionID: "ses_budget" })
    const request = { sessionID: "ses_budget", baseURL: undefined as string | undefined }
    await hooks.get("model.request")!(request)
    expect(request.baseURL).toStartWith("http://127.0.0.1:")
    await cleanup?.()
  })

  test("injects research rules once and routes effort/budget", async () => {
    const { ctx, hooks } = mockContext()
    await plugin.setup(ctx as any)
    const context = hooks.get("context")!

    const event = {
      agent: "critic",
      system: [] as { type: string; text: string }[],
      options: {} as Record<string, unknown>,
    }

    await context(event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]!.text).toContain("科研模式")
    expect(event.options.reasoningEffort).toBe("max")
    expect(event.options.maxTokens).toBe(16_000)

    await context(event)
    expect(event.system).toHaveLength(1)
  })

  test("compaction adds research rules, low effort, and a 12k budget", async () => {
    const { ctx, hooks } = mockContext()
    await plugin.setup(ctx as any)

    const event = {
      system: [] as { type: string; text: string }[],
      options: {} as Record<string, unknown>,
    }

    await hooks.get("compaction")!(event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]!.text).toContain("科研压缩要求")
    expect(event.options.reasoningEffort).toBe("low")
    expect(event.options.maxTokens).toBe(12_000)

    await hooks.get("compaction")!(event)
    expect(event.system).toHaveLength(1)
  })

  test("prunes a large shell result", async () => {
    const { ctx, hooks } = mockContext()
    const cleanup = await plugin.setup(ctx as any)

    const event = {
      tool: "shell",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      input: { command: "python train.py --seed 7" },
      result: {
        content: [{ type: "text", text: "x".repeat(40_000) }],
        metadata: { exit: 0 } as Record<string, unknown>,
      },
    }

    await hooks.get("tool:execute.after")!(event)
    const content = event.result.content as any[]
    expect(content[0].text.length).toBeLessThanOrEqual(32_000)
    expect(content[0].text).toContain("spilled to")
    expect(content[content.length - 1].text).toContain("Preview only")

    await cleanup?.()
  })

  test("does not spill a small tool result", async () => {
    const { ctx, hooks } = mockContext()
    const cleanup = await plugin.setup(ctx as any)

    const event = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      result: { content: "small output" },
    }

    await hooks.get("tool:execute.after")!(event)
    expect(event.result.content).toBe("small output")
    await cleanup?.()
  })
})

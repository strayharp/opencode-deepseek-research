import { describe, expect, test } from "bun:test"
import {
  PRESET_AGENTS,
  PRESET_COMMANDS,
  PRESET_SKILLS,
  registerAgentPresets,
  registerResearchCommands,
  registerResearchSkills,
  renderCommand,
} from "../plugin/presets.ts"

function agentDomain(existing: Map<string, any> = new Map()) {
  const agents = new Map(existing)
  return {
    agents,
    domain: {
      async transform(callback: (editor: any) => void) {
        callback({
          get: (id: string) => agents.get(id),
          update: (id: string, update: (agent: any) => void) => {
            const agent = agents.get(id) ?? { id, name: id, mode: "primary", hidden: false, system: "" }
            update(agent)
            agents.set(id, agent)
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
}

function skillDomain(existing: Map<string, any> = new Map()) {
  const skills = new Map(existing)
  return {
    skills,
    domain: {
      async transform(callback: (editor: any) => void) {
        callback({
          get: (id: string) => skills.get(id),
          add: (skill: any) => skills.set(skill.id, skill),
        })
        return { dispose: async () => {} }
      },
    },
  }
}

function commandDomain() {
  const commands: any[] = []
  return {
    commands,
    domain: {
      async transform(callback: (editor: any) => void) {
        callback({ add: (command: any) => commands.push(command) })
        return { dispose: async () => {} }
      },
    },
  }
}

describe("research presets", () => {
  test("registers five agent presets without overwriting user agents", async () => {
    const custom = { id: "writer", name: "Custom Writer", mode: "primary", hidden: false, system: "custom" }
    const fake = agentDomain(new Map([["writer", custom]]))
    await registerAgentPresets(fake.domain)
    expect(fake.agents.size).toBe(PRESET_AGENTS.length)
    expect(fake.agents.get("writer")).toBe(custom)
    expect(fake.agents.get("writer")!.system).toBe("custom")
    for (const preset of PRESET_AGENTS.filter((agent) => agent.id !== "writer")) {
      expect(fake.agents.get(preset.id)).toMatchObject({
        id: preset.id,
        name: preset.name,
        mode: "all",
        hidden: false,
        system: preset.system,
      })
    }
  })

  test("registers embedded research skills and preserves existing ids", async () => {
    const custom = { id: "deepseek-latex", name: "Custom LaTeX", content: "custom" }
    const fake = skillDomain(new Map([["deepseek-latex", custom]]))
    await registerResearchSkills(fake.domain)
    expect(fake.skills.size).toBe(PRESET_SKILLS.length)
    expect(fake.skills.get("deepseek-latex")).toBe(custom)
    expect(fake.skills.get("deepseek-paper-reading")).toMatchObject({
      autoinvoke: true,
      path: "/builtin/deepseek-research/deepseek-paper-reading.md",
    })
  })

  test("registers five commands and switches to the mapped agent", async () => {
    const fake = commandDomain()
    const prompts: any[] = []
    const switches: any[] = []
    await registerResearchCommands(fake.domain, {
      session: {
        prompt: async (input) => {
          prompts.push(input)
        },
        switchAgent: async (input) => {
          switches.push(input)
        },
      },
      agent: {
        get: async ({ agentID }) => ({ data: { id: agentID } }),
      },
    })
    expect(fake.commands.map((command) => command.name).sort()).toEqual(
      PRESET_COMMANDS.map((command) => command.name).sort(),
    )
    const lit = fake.commands.find((command) => command.name === "lit")!
    await lit.execute({ sessionID: "ses_1", prompt: { text: "graph neural networks" }, delivery: "steer" })
    expect(switches).toEqual([{ sessionID: "ses_1", agent: "scout" }])
    expect(prompts[0]).toMatchObject({
      sessionID: "ses_1",
      delivery: "steer",
      metadata: { source: "deepseek-research", command: "lit" },
    })
    expect(prompts[0].text).toContain("literature-review")
    expect(prompts[0].text).toContain("graph neural networks")
  })

  test("still prompts when the preset agent is unavailable or switching fails", async () => {
    const fake = commandDomain()
    const prompts: any[] = []
    const warnings: string[] = []
    await registerResearchCommands(fake.domain, {
      session: {
        prompt: async (input) => {
          prompts.push(input)
        },
        switchAgent: async () => {
          throw new Error("busy")
        },
      },
      agent: { get: async () => ({ data: { id: "scout" } }) },
      warn: (message) => warnings.push(message),
    })
    const prereg = fake.commands.find((command) => command.name === "prereg")!
    await prereg.execute({ sessionID: "ses_2", prompt: { text: "new hypothesis" } })
    expect(warnings[0]).toContain("could not switch")
    expect(prompts[0].text).toContain("preregistration")
    expect(prompts[0].text).toContain("new hypothesis")

    const missing = commandDomain()
    await registerResearchCommands(missing.domain, {
      session: { prompt: async () => {} },
      agent: {
        get: async () => {
          throw new Error("not found")
        },
      },
      warn: () => {},
    })
    const paper = missing.commands.find((command) => command.name === "paper")!
    await paper.execute({ sessionID: "ses_3", prompt: { text: "results" } })
  })

  test("renders an explicit placeholder for an empty command input", () => {
    const command = PRESET_COMMANDS.find((item) => item.name === "verify")!
    expect(renderCommand(command, "  ")).toContain("none provided")
    expect(renderCommand(command, "the answer")).toContain("the answer")
  })
})

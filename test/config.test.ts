import { describe, expect, test } from "bun:test"

function parseJsonc(text: string) {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"),
  )
}

const config = parseJsonc(await Bun.file(new URL("../examples/opencode.deepseek.jsonc", import.meta.url)).text())

describe("opencode.deepseek.jsonc", () => {
  test("uses the DeepSeek Messages provider", () => {
    expect(config.providers.deepseek.package).toBe("@opencode/ai/providers/anthropic-compatible")
    expect(config.providers.deepseek.settings.baseURL).toBe("https://api.deepseek.com/anthropic")
    expect(config.providers.deepseek.env).toContain("DEEPSEEK_API_KEY")
  })

  test("declares the DeepSeek model and context limits", () => {
    const model = config.providers.deepseek.models["deepseek-flash"]
    expect(model.name).toContain("DeepSeek V4.1 Flash 1017")
    expect(model.limit.context).toBe(1_000_000)
    expect(model.limit.output).toBe(393_216)
    expect(model.capabilities.reasoning.effort).toEqual(["low", "high", "max"])
  })

  test("keeps a research-sized compaction budget", () => {
    expect(config.compaction.auto).toBe(true)
    expect(config.compaction.buffer).toBe(65_536)
    expect(config.compaction.keep.tokens).toBe(120_000)
  })

  test("loads the local plugin with research options", () => {
    expect(config.plugins).toContainEqual({
      package: "./opencode-deepseek-research",
      options: {
        toolResultLimit: 32_000,
        cacheMinPromptTokens: 200_000,
        cacheMinHitRate: 0.5,
        pythonPath: "python3",
        runCodeTimeoutSec: 600,
        runCodeCpuSec: 60,
        runCodeMemoryMb: 2_048,
        runCodeNetwork: false,
        runCodeKernel: "persistent",
        verifyNetwork: true,
        verifyGate: true,
        verifyMaxGates: 1,
        bestOfN: true,
        bestOfNMaxCandidates: 5,
        bestOfNTimeoutSec: 600,
        bestOfNJudge: true,
        bestOfNJudgeTimeoutSec: 180,
        bestOfNNotify: true,
        agentPresets: true,
        researchSkills: true,
        researchCommands: true,
        budgetUSD: 0,
        budgetScope: "project",
        budgetNotify: true,
      },
    })
  })
})

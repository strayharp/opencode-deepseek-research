import { describe, expect, test } from "bun:test"
import {
  CACHE_AUDIT_MIN_PROMPT_TOKENS,
  COMPACTION_RULES,
  RESEARCH_RULES,
  cacheStats,
  createCacheAuditor,
  createToolResultPruner,
  effortFor,
  hasCompactionRules,
  hasResearchRules,
  maxTokensFor,
  pruneToolText,
  shouldWarnCache,
  spillPathFor,
} from "../plugin/policy.ts"

describe("effortFor", () => {
  test("critic gets max effort", () => {
    expect(effortFor("critic")).toBe("max")
  })

  test("scout and writer run cheap", () => {
    expect(effortFor("scout")).toBe("low")
    expect(effortFor("writer")).toBe("low")
  })

  test("experimenter and analyst run high", () => {
    expect(effortFor("experimenter")).toBe("high")
    expect(effortFor("analyst")).toBe("high")
  })

  test("unknown agents default to high", () => {
    expect(effortFor("unknown")).toBe("high")
  })
})

describe("maxTokensFor", () => {
  test("scout has a small budget", () => {
    expect(maxTokensFor("scout")).toBe(8_000)
  })

  test("writer has the largest default budget", () => {
    expect(maxTokensFor("writer")).toBe(32_000)
  })

  test("unknown agents default to 16k", () => {
    expect(maxTokensFor("unknown")).toBe(16_000)
  })
})

describe("RESEARCH_RULES", () => {
  test("carries the non-negotiable research constraints", () => {
    expect(RESEARCH_RULES).toContain("insufficient evidence")
    expect(RESEARCH_RULES).toContain("seed")
    expect(RESEARCH_RULES).toContain("相关与因果")
    expect(RESEARCH_RULES).toContain("best_of_n")
  })
})

describe("hasResearchRules", () => {
  test("detects an existing rule block", () => {
    expect(hasResearchRules([{ text: "科研模式（DeepSeek）" }])).toBe(true)
  })

  test("ignores unrelated system parts", () => {
    expect(hasResearchRules([{ text: "You are a coding agent" }])).toBe(false)
  })
})

describe("COMPACTION_RULES", () => {
  test("preserves evidence, experiment state, and open questions", () => {
    expect(COMPACTION_RULES).toContain("DOI/arXiv/URL/文件路径")
    expect(COMPACTION_RULES).toContain("seed")
    expect(COMPACTION_RULES).toContain("未解决问题")
    expect(COMPACTION_RULES).toContain("insufficient evidence")
  })

  test("detects an existing compaction block", () => {
    expect(hasCompactionRules([{ text: "科研压缩要求：保留实验配置" }])).toBe(true)
    expect(hasCompactionRules([{ text: "Summarize the conversation" }])).toBe(false)
  })
})

describe("cacheStats", () => {
  test("computes prompt tokens, hit rate, and total tokens", () => {
    const stats = cacheStats({
      input: 100,
      output: 50,
      reasoning: 25,
      cache: { read: 300, write: 0 },
    })
    expect(stats.promptTokens).toBe(400)
    expect(stats.cachedTokens).toBe(300)
    expect(stats.hitRate).toBe(0.75)
    expect(stats.totalTokens).toBe(475)
  })

  test("handles an empty usage snapshot", () => {
    const stats = cacheStats({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(stats.hitRate).toBe(0)
    expect(stats.promptTokens).toBe(0)
  })
})

describe("shouldWarnCache", () => {
  test("warns only after enough prompt tokens and a low hit rate", () => {
    const cold = cacheStats({
      input: CACHE_AUDIT_MIN_PROMPT_TOKENS / 2,
      output: 0,
      reasoning: 0,
      cache: { read: CACHE_AUDIT_MIN_PROMPT_TOKENS / 2, write: 0 },
    })
    expect(shouldWarnCache(cold)).toBe(false)

    const lowHit = cacheStats({
      input: 190_000,
      output: 0,
      reasoning: 0,
      cache: { read: 10_000, write: 0 },
    })
    expect(shouldWarnCache(lowHit)).toBe(true)

    const healthy = cacheStats({
      input: 100_000,
      output: 0,
      reasoning: 0,
      cache: { read: 300_000, write: 0 },
    })
    expect(shouldWarnCache(healthy)).toBe(false)
  })
})

describe("createCacheAuditor", () => {
  test("persists usage and warns once per session", async () => {
    const saves: { sessionID: string; hitRate: number }[] = []
    const warnings: string[] = []
    const audit = createCacheAuditor({
      save: (sessionID, stats) => {
        saves.push({ sessionID, hitRate: stats.hitRate })
      },
      warn: (message) => {
        warnings.push(message)
      },
    })

    const event = {
      type: "session.usage.updated",
      data: {
        sessionID: "ses_test",
        tokens: { input: 190_000, output: 10, reasoning: 5, cache: { read: 10_000, write: 0 } },
      },
    }

    expect(await audit(event)).toBe(true)
    expect(await audit(event)).toBe(true)
    expect(saves).toHaveLength(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("low prompt-cache hit rate")
  })

  test("honors custom prompt and hit-rate thresholds", async () => {
    const warnings: string[] = []
    const audit = createCacheAuditor({
      save: () => {},
      warn: (message) => {
        warnings.push(message)
      },
      minPromptTokens: 100,
      minHitRate: 0.9,
    })

    await audit({
      type: "session.usage.updated",
      data: {
        sessionID: "ses_custom",
        tokens: { input: 90, output: 0, reasoning: 0, cache: { read: 10, write: 0 } },
      },
    })
    expect(warnings).toHaveLength(1)
  })

  test("ignores unrelated events", async () => {
    let saves = 0
    const audit = createCacheAuditor({
      save: () => {
        saves += 1
      },
      warn: () => {},
    })
    expect(await audit({ type: "session.created" })).toBe(false)
    expect(saves).toBe(0)
  })
})

describe("pruneToolText", () => {
  test("keeps short results untouched", () => {
    const result = pruneToolText("short output", "/tmp/spill.txt", 100)
    expect(result.spilled).toBe(false)
    expect(result.text).toBe("short output")
  })

  test("bounds large results and points at the spill file", () => {
    const text = "a".repeat(5_000) + "z".repeat(5_000)
    const result = pruneToolText(text, "/tmp/spill.txt", 2_000)
    expect(result.spilled).toBe(true)
    expect(result.originalChars).toBe(10_000)
    expect(result.text.length).toBeLessThanOrEqual(2_000)
    expect(result.text).toContain("/tmp/spill.txt")
    expect(result.text).toContain("chars omitted")
    expect(result.text).toContain("aaa")
    expect(result.text).toContain("zzz")
  })
})

describe("spillPathFor", () => {
  test("uses a per-session, per-call path", () => {
    expect(spillPathFor("/tmp/base/", "ses_1", "call_1")).toBe("/tmp/base/ses_1/call_1.txt")
  })
})

describe("createToolResultPruner", () => {
  test("spills a large string result and leaves metadata", async () => {
    const writes: { path: string; text: string }[] = []
    const prune = createToolResultPruner({
      limit: 100,
      spillPath: (sessionID, callID) => `/tmp/${sessionID}/${callID}.txt`,
      writeSpill: async (path, text) => {
        writes.push({ path, text })
      },
    })

    const event = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed" as const,
      result: { content: "x".repeat(500), metadata: { exit: 0 } },
    }

    expect(await prune(event)).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe("/tmp/ses_1/call_1.txt")
    expect(writes[0]!.text).toHaveLength(500)
    expect(event.result.content.length).toBeLessThanOrEqual(100)
    expect(event.result.metadata).toMatchObject({
      exit: 0,
      deepseekResearchSpill: "/tmp/ses_1/call_1.txt",
      originalChars: 500,
    })
  })

  test("spills array-shaped shell results and preserves file parts", async () => {
    const writes: { path: string; text: string }[] = []
    const prune = createToolResultPruner({
      limit: 100,
      spillPath: () => "/tmp/shell.txt",
      writeSpill: async (path, text) => {
        writes.push({ path, text })
      },
    })

    const file = { type: "file" as const, uri: "file:///tmp/a.txt", mime: "text/plain" }
    const event = {
      tool: "shell",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed" as const,
      result: { content: [{ type: "text" as const, text: "x".repeat(500) }, file] },
    }

    expect(await prune(event)).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.text).toHaveLength(500)
    expect(Array.isArray(event.result.content)).toBe(true)
    const content = event.result.content as any[]
    expect(content[0].type).toBe("text")
    expect(content[0].text.length).toBeLessThanOrEqual(100)
    expect(content[1]).toEqual(file)
  })

  test("leaves short results and non-completed calls alone", async () => {
    let writes = 0
    const prune = createToolResultPruner({
      limit: 100,
      spillPath: () => "/tmp/x.txt",
      writeSpill: async () => {
        writes += 1
      },
    })

    const short = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed" as const,
      result: { content: "ok" },
    }
    expect(await prune(short)).toBe(false)

    const failed = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_2",
      status: "error" as const,
    }
    expect(await prune(failed)).toBe(false)
    expect(writes).toBe(0)
  })

  test("keeps the original result when spilling fails", async () => {
    const warnings: string[] = []
    const prune = createToolResultPruner({
      limit: 10,
      spillPath: () => "/tmp/x.txt",
      writeSpill: async () => {
        throw new Error("disk full")
      },
      warn: (message) => {
        warnings.push(message)
      },
    })

    const event = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed" as const,
      result: { content: "x".repeat(100) },
    }

    expect(await prune(event)).toBe(false)
    expect(event.result.content).toHaveLength(100)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("failed to spill")
  })
})

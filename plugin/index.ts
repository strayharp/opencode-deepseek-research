import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { createBudgetGuardServer } from "./budget-server.ts"
import { budgetNotice, createCostReportTool, createCostTracker } from "./cost.ts"
import { createBestOfNTools } from "./bestofn.ts"
import { createExperimentStore, createExperimentTools } from "./experiments.ts"
import { createVerifyGate } from "./gate.ts"
import { createPythonKernelManager } from "./kernel.ts"
import {
  registerAgentPresets,
  registerResearchCommands,
  registerResearchSkills,
} from "./presets.ts"
import { createRunCodeTools } from "./runtime.ts"
import { createVerifyTools, invalidateVerificationReceipt } from "./verify.ts"
import {
  CACHE_AUDIT_MIN_HIT_RATE,
  CACHE_AUDIT_MIN_PROMPT_TOKENS,
  COMPACTION_RULES,
  RESEARCH_RULES,
  TOOL_RESULT_LIMIT,
  createCacheAuditor,
  createToolResultPruner,
  effortFor,
  hasCompactionRules,
  hasResearchRules,
  maxTokensFor,
  spillPathFor,
} from "./policy.ts"

const CACHE_KEY = (sessionID: string) => `deepseek-research:cache:${sessionID}`
const SPILL_DIR = join(tmpdir(), "opencode-deepseek-research")

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function fraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

export default Plugin.define({
  id: "deepseek.research",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      if (!hasResearchRules(event.system)) {
        event.system.push({ type: "text", text: RESEARCH_RULES })
      }
      event.options.reasoningEffort = effortFor(event.agent)
      event.options.maxTokens = maxTokensFor(event.agent)
    })

    await ctx.session.hook("compaction", (event) => {
      if (!hasCompactionRules(event.system)) {
        event.system.push({ type: "text", text: COMPACTION_RULES })
      }
      event.options.reasoningEffort = "low"
      event.options.maxTokens = 12_000
    })

    const options = ctx.options ?? {}
    const cacheMinPromptTokens = Math.floor(
      positiveNumber(options.cacheMinPromptTokens, CACHE_AUDIT_MIN_PROMPT_TOKENS),
    )
    const cacheMinHitRate = fraction(options.cacheMinHitRate, CACHE_AUDIT_MIN_HIT_RATE)
    const toolResultLimit = Math.max(1_000, Math.floor(positiveNumber(options.toolResultLimit, TOOL_RESULT_LIMIT)))
    const pythonPath =
      typeof options.pythonPath === "string" && options.pythonPath.trim()
        ? options.pythonPath.trim()
        : process.env.PYTHON || "python3"
    const runCodeTimeoutSec = Math.floor(positiveNumber(options.runCodeTimeoutSec, 600))
    const runCodeCpuSec = Math.floor(positiveNumber(options.runCodeCpuSec, 60))
    const runCodeMemoryMb = Math.floor(positiveNumber(options.runCodeMemoryMb, 2_048))
    const runCodeNetwork = options.runCodeNetwork === true
    const runCodeKernel = options.runCodeKernel === "persistent" ? "persistent" : "fresh"
    const kernelManager =
      runCodeKernel === "persistent"
        ? createPythonKernelManager({
            pythonPath,
            memoryMb: runCodeMemoryMb,
          })
        : undefined
    const verifyNetwork = options.verifyNetwork !== false
    const verifyGateEnabled = options.verifyGate !== false
    const verifyMaxGates = Math.max(1, Math.floor(positiveNumber(options.verifyMaxGates, 1)))
    const bestOfNEnabled = options.bestOfN !== false
    const bestOfNMaxCandidates = Math.max(
      3,
      Math.min(5, Math.floor(positiveNumber(options.bestOfNMaxCandidates, 5))),
    )
    const bestOfNTimeoutSec = Math.floor(positiveNumber(options.bestOfNTimeoutSec, 600))
    const bestOfNJudge = options.bestOfNJudge !== false
    const bestOfNJudgeTimeoutSec = Math.floor(positiveNumber(options.bestOfNJudgeTimeoutSec, 180))
    const bestOfNNotify = options.bestOfNNotify !== false
    const agentPresets = options.agentPresets !== false
    const researchSkills = options.researchSkills !== false
    const researchCommands = options.researchCommands !== false
    const budgetUSD =
      typeof options.budgetUSD === "number" && Number.isFinite(options.budgetUSD) && options.budgetUSD > 0
        ? options.budgetUSD
        : undefined
    const budgetScope =
      options.budgetScope === "session" || options.budgetScope === "task" ? options.budgetScope : "project"
    const budgetNotify = options.budgetNotify !== false
    const warn = (message: string, error?: unknown) =>
      error === undefined ? console.warn(message) : console.warn(message, error)

    if (agentPresets && typeof (ctx.agent as any)?.transform === "function") {
      try {
        await registerAgentPresets(ctx.agent as any)
      } catch (error) {
        warn("[deepseek-research] failed to register agent presets", error)
      }
    }
    if (researchSkills && typeof (ctx.skill as any)?.transform === "function") {
      try {
        await registerResearchSkills(ctx.skill as any)
      } catch (error) {
        warn("[deepseek-research] failed to register research skills", error)
      }
    }
    if (
      researchCommands &&
      typeof (ctx.command as any)?.transform === "function" &&
      typeof (ctx.session as any)?.prompt === "function"
    ) {
      try {
        await registerResearchCommands(ctx.command as any, {
          session: ctx.session as any,
          agent: ctx.agent as any,
          warn,
        })
      } catch (error) {
        warn("[deepseek-research] failed to register research commands", error)
      }
    }

    const projectID = String(ctx.location?.project?.id ?? "default")
    const baseDir = String(ctx.location?.directory ?? process.cwd())
    let budgetGuard: Awaited<ReturnType<typeof createBudgetGuardServer>> | undefined
    if (budgetUSD !== undefined) {
      try {
        budgetGuard = await createBudgetGuardServer()
      } catch (error) {
        warn("[deepseek-research] failed to start budget guard endpoint", error)
      }
    }
    const costTracker = createCostTracker({
      storage: ctx.storage as any,
      projectID,
      budgets: {
        ...(budgetUSD === undefined ? {} : { usd: budgetUSD }),
        scope: budgetScope,
      },
      warn,
      onExceeded: ({ sessionID, status }) => {
        warn(
          `[deepseek-research] budget exceeded (${status.reasons.join(", ")}); ` +
            `USD ${status.usd.toFixed(6)}${status.usdLimit === undefined ? "" : `/${status.usdLimit}`}`,
        )
        if (!sessionID || !budgetNotify || typeof (ctx.session as any)?.synthetic !== "function") return
        // Do not interrupt the current step: let an in-flight response finish,
        // then the model.request hook and tool guard stop the next step. The
        // synthetic notice is best-effort and may be queued until the session
        // next drains.
        void Promise.resolve(
          ctx.session.synthetic({
            sessionID,
            text: budgetNotice(status),
            description: "deepseek-research budget guard",
            metadata: {
              source: "deepseek-research",
              budget: {
                limited: status.limited,
                exceeded: status.exceeded,
                reasons: [...status.reasons],
                usd: status.usd,
                ...(status.usdLimit === undefined ? {} : { usdLimit: status.usdLimit }),
                scope: status.scope,
              },
            },
            resume: false,
          }),
        ).catch((error) => warn("[deepseek-research] failed to post budget notice", error))
      },
    })
    try {
      await costTracker.load()
    } catch (error) {
      warn("[deepseek-research] failed to load cost history", error)
    }
    await ctx.session.hook("model.request", async (event) => {
      const sessionID = (event as any)?.sessionID
      if (typeof sessionID !== "string") return
      const status = await costTracker.check(sessionID)
      if (!status.exceeded) return
      await costTracker.enforce(sessionID, status)
      // Session hooks cannot reject. Route the blocked request to a local 402
      // endpoint so no provider request (and no cost) is made.
      ;(event as any).baseURL = budgetGuard?.url ?? "http://127.0.0.1:9"
    })

    const audit = createCacheAuditor({
      save: async (sessionID, stats) => {
        await ctx.storage.set(CACHE_KEY(sessionID), { ...stats } as any)
      },
      warn: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
      minPromptTokens: cacheMinPromptTokens,
      minHitRate: cacheMinHitRate,
    })

    let verifyGate: ReturnType<typeof createVerifyGate> | undefined
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await audit(event as any)
          try {
            await costTracker.handle(event as any)
          } catch (error) {
            console.warn("[deepseek-research] cost tracker failed", error)
          }
          if (verifyGate) {
            try {
              await verifyGate.handle(event as any)
            } catch (error) {
              console.warn("[deepseek-research] verify gate failed", error)
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[deepseek-research] cache audit stopped", error)
        }
      }
    })()

    const experimentStore = createExperimentStore(ctx.storage as any, `exp:${projectID}`)
    if (
      verifyGateEnabled &&
      typeof (ctx.session as any)?.context === "function" &&
      typeof (ctx.session as any)?.synthetic === "function" &&
      typeof (ctx.storage as any)?.get === "function"
    ) {
      verifyGate = createVerifyGate({
        session: ctx.session as any,
        storage: ctx.storage as any,
        projectID,
        enabled: true,
        maxGates: verifyMaxGates,
        warn: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
      })
      await ctx.session.hook("prompt", async (event) => {
        const sessionID = (event as any)?.sessionID
        if (typeof sessionID !== "string") return
        verifyGate?.reset(sessionID)
        try {
          await invalidateVerificationReceipt(ctx.storage as any, projectID, sessionID)
        } catch (error) {
          console.warn("[deepseek-research] failed to invalidate verification receipt", error)
        }
      })
    }
    const bestOfNTools = bestOfNEnabled
      ? createBestOfNTools({
          session: ctx.session as any,
          storage: ctx.storage as any,
          projectID,
          maxCandidates: bestOfNMaxCandidates,
          timeoutSec: bestOfNTimeoutSec,
          judge: bestOfNJudge,
          judgeTimeoutSec: bestOfNJudgeTimeoutSec,
          background: true,
          notify: bestOfNNotify,
        })
      : undefined
    const pluginTools = [
      createCostReportTool(costTracker),
      ...createExperimentTools({ store: experimentStore, baseDir }),
      ...createVerifyTools({
        baseDir,
        experiments: experimentStore,
        storage: ctx.storage as any,
        projectID,
        pythonPath,
        network: verifyNetwork,
      }),
      ...(bestOfNTools ?? []),
      ...createRunCodeTools({
        baseDir,
        pythonPath,
        timeoutSec: runCodeTimeoutSec,
        cpuSec: runCodeCpuSec,
        memoryMb: runCodeMemoryMb,
        network: runCodeNetwork,
        experiments: experimentStore,
        ...(kernelManager ? { kernel: kernelManager } : {}),
      }),
    ]
    await ctx.tool.transform((editor) => {
      for (const tool of pluginTools) editor.add(tool as any)
    })

    const prune = createToolResultPruner({
      limit: toolResultLimit,
      spillPath: (sessionID, callID) => spillPathFor(SPILL_DIR, sessionID, callID),
      writeSpill: async (path, text) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, text, { encoding: "utf8", mode: 0o600 })
      },
      warn: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
    })

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool === "cost_report") return
      const status = await costTracker.check(event.sessionID)
      if (!status.exceeded) return
      await costTracker.enforce(event.sessionID, status)
      throw new Error(
        `[deepseek-research] budget exceeded (${status.reasons.join(", ")}); ` +
          `USD ${status.usd.toFixed(6)}${status.usdLimit === undefined ? "" : `/${status.usdLimit}`}. ` +
          `Use cost_report to inspect usage and raise budgetUSD in config before continuing.`,
      )
    })

    await ctx.tool.hook("execute.after", async (event) => {
      await prune(event as any)
    })

    return () => {
      void bestOfNTools?.close?.()
      void kernelManager?.close()
      void budgetGuard?.close()
      controller.abort()
    }
  },
})

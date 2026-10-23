import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExperimentStore, type ExperimentStorage } from "../plugin/experiments.ts"
import { createPythonKernelManager, type PythonKernelManager } from "../plugin/kernel.ts"
import { runCode } from "../plugin/runtime.ts"

const roots: string[] = []
const managers: PythonKernelManager[] = []

function memoryStore() {
  const data = new Map<string, unknown>()
  const storage: ExperimentStorage = {
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
  return createExperimentStore(storage, "exp:test")
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "deepseek-kernel-"))
  roots.push(root)
  const manager = createPythonKernelManager({
    pythonPath: "python3",
    memoryMb: 2_048,
    rootDir: join(root, "kernels"),
  })
  managers.push(manager)
  return { root, manager }
}

afterAll(async () => {
  for (const manager of managers) await manager.close().catch(() => {})
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe("persistent Python kernel", () => {
  test("keeps variables and imports across calls in one session", async () => {
    const { root, manager } = await setup()
    const first = await runCode(
      { code: "import math\nx = 41\nresult = math.sqrt(x + 1)" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_state", id: "call_1" },
    )
    expect(first.ok).toBe(true)
    expect(first.value).toBeCloseTo(6.4807, 3)

    const second = await runCode(
      { code: "result = {'x': x, 'sqrt': round(math.sqrt(x + 1), 3)}" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_state", id: "call_2" },
    )
    expect(second.ok).toBe(true)
    expect(second.value).toEqual({ x: 41, sqrt: 6.481 })
  })

  test("does not share state between sessions", async () => {
    const { root, manager } = await setup()
    await runCode(
      { code: "secret = 'only-a'" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_a", id: "call_a" },
    )
    const other = await runCode(
      { code: "result = 'secret' in globals()" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_b", id: "call_b" },
    )
    expect(other.value).toBe(false)
  })

  test("ingests experiments recorded inside a persistent kernel", async () => {
    const { root, manager } = await setup()
    const store = memoryStore()
    const result = await runCode(
      {
        code: "tools.exp_record(hypothesis='kernel experiment', metrics={'score': 0.8})\nresult = 'recorded'",
      },
      { baseDir: root, timeoutSec: 10, kernel: manager, experiments: store },
      { sessionID: "ses_exp", id: "call_exp" },
    )
    expect(result.ok).toBe(true)
    expect(result.experiments).toHaveLength(1)
    const experiment = await store.get(result.experiments[0]!.id)
    expect(experiment?.metrics.score).toBe(0.8)
    expect(experiment?.config.runCode).toBe(true)
  })

  test("resets result between calls and captures output", async () => {
    const { root, manager } = await setup()
    await runCode(
      { code: "result = 'first'\nprint('hello from kernel')" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_result", id: "call_1" },
    )
    const second = await runCode(
      { code: "print('second call')" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_result", id: "call_2" },
    )
    expect(second.ok).toBe(true)
    expect(second.value).toBeNull()
    expect(second.stdout).toContain("second call")
    expect(second.stdout).not.toContain("hello from kernel")
  })

  test("blocks network by default and recovers after a timeout", async () => {
    const { root, manager } = await setup()
    const blocked = await runCode(
      { code: "import socket\nsocket.create_connection(('example.com', 80), timeout=1)" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_net", id: "call_net" },
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.stderr).toContain("network disabled by run_code")

    const timed = await runCode(
      { code: "import time\ntime.sleep(5)" },
      { baseDir: root, timeoutSec: 1, kernel: manager },
      { sessionID: "ses_timeout", id: "call_timeout" },
    )
    expect(timed.timedOut).toBe(true)
    expect(timed.ok).toBe(false)

    const recovered = await runCode(
      { code: "result = 7" },
      { baseDir: root, timeoutSec: 10, kernel: manager },
      { sessionID: "ses_timeout", id: "call_recovered" },
    )
    expect(recovered.ok).toBe(true)
    expect(recovered.value).toBe(7)
  }, 20_000)
})

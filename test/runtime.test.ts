import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExperimentStore, type ExperimentStorage } from "../plugin/experiments.ts"
import { createRunCodeTools, runCode } from "../plugin/runtime.ts"

const roots: string[] = []

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "deepseek-runtime-"))
  roots.push(root)
  return root
}

function memoryStorage() {
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

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe("runCode", () => {
  test("returns a compact value and captures stdout/stderr", async () => {
    const root = await tempProject()
    const result = await runCode(
      {
        code: "print('hello')\nresult = {'sum': sum(range(10)), 'name': 'ok'}",
      },
      { baseDir: root, timeoutSec: 10 },
    )

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.value).toEqual({ sum: 45, name: "ok" })
    expect(result.stdout).toContain("hello")
    expect(result.stderr).toBe("")
    expect((await stat(result.codePath)).size).toBeGreaterThan(0)
  })

  test("runs a scientific fragment, saves a plot, and records an experiment", async () => {
    const root = await tempProject()
    const store = memoryStorage()
    const result = await runCode(
      {
        code: `
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

frame = pd.DataFrame({"x": [1, 2, 3], "y": [2, 4, 6]})
accuracy = float((frame["y"] == frame["x"] * 2).mean())
fig, ax = plt.subplots()
ax.plot(frame["x"], frame["y"])
plot = tools.savefig("linear.png")
tools.exp_record(
    hypothesis="linear relation",
    metrics={"accuracy": accuracy},
    config={"rows": len(frame)},
)
result = {
    "accuracy": accuracy,
    "shape": list(frame.shape),
    "plot": plot,
    "array": np.arange(5),
}
`,
      },
      { baseDir: root, timeoutSec: 60, experiments: store },
    )

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ accuracy: 1, shape: [3, 2] })
    expect((result.value as any).array).toMatchObject({ __type__: "ndarray", shape: [5] })
    expect(result.artifacts).toHaveLength(1)
    expect((await stat(result.artifacts[0]!)).size).toBeGreaterThan(0)
    expect(result.experiments).toHaveLength(1)

    const experiment = await store.get(result.experiments[0]!.id)
    expect(experiment?.metrics.accuracy).toBe(1)
    expect(experiment?.config.runCode).toBe(true)
    expect(experiment?.artifacts).toContain(result.artifacts[0])
  }, 60_000)

  test("reports Python exceptions without crashing the tool", async () => {
    const root = await tempProject()
    const result = await runCode(
      { code: "raise ValueError('boom')" },
      { baseDir: root, timeoutSec: 10 },
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("ValueError: boom")
    expect(result.error).toContain("ValueError")
  })

  test("enforces the wall-clock timeout", async () => {
    const root = await tempProject()
    const result = await runCode(
      { code: "import time\ntime.sleep(10)" },
      { baseDir: root, timeoutSec: 1 },
    )

    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.durationMs).toBeLessThan(5_000)
  })

  test("caps output files and returns a bounded preview", async () => {
    const root = await tempProject()
    const result = await runCode(
      { code: "print('x' * 50_000)" },
      { baseDir: root, timeoutSec: 10, outputCapBytes: 1_024, previewBytes: 512 },
    )

    expect(result.ok).toBe(true)
    expect(result.stdoutBytes).toBeGreaterThan(1_024)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout).toContain("…[truncated]…")
    expect((await stat(result.stdoutPath)).size).toBe(1_024)
  })

  test("blocks outbound network by default", async () => {
    const root = await tempProject()
    const result = await runCode(
      {
        code: "import socket\nsocket.create_connection(('example.com', 80), timeout=1)",
      },
      { baseDir: root, timeoutSec: 10 },
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("network disabled by run_code")
  })

  test("registers run_code as a direct tool", async () => {
    const root = await tempProject()
    const tools = createRunCodeTools({ baseDir: root, timeoutSec: 10 })
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("run_code")
    expect(tools[0]!.options.codemode).toBe(false)

    const response = await tools[0]!.execute({ code: "result = 7" }, { sessionID: "ses_1", id: "call_1" })
    expect(JSON.parse(response.content).value).toBe(7)
  })
})

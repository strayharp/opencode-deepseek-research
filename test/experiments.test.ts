import { describe, expect, test } from "bun:test"
import {
  bestExperiments,
  compareExperiments,
  createExperimentStore,
  createExperimentTools,
  defaultExperimentId,
  normalizeArtifact,
  queryExperiments,
  recordExperiment,
} from "../plugin/experiments.ts"
import type { ExperimentStorage } from "../plugin/experiments.ts"

const BASE = "/work/project"
const T0 = "2026-10-23T00:00:00.000Z"
const T1 = "2026-10-23T01:00:00.000Z"

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
  return { storage, data }
}

function newStore() {
  const { storage, data } = memoryStorage()
  return { store: createExperimentStore(storage, "exp:proj"), data }
}

async function seed(
  store: ReturnType<typeof newStore>["store"],
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return recordExperiment(
    store,
    {
      id,
      hypothesis: `hypothesis ${id}`,
      status: "completed",
      metrics: { accuracy: 0.8 },
      ...overrides,
    } as any,
    { baseDir: BASE, now: () => T0 },
  )
}

describe("recordExperiment", () => {
  test("creates a reproducible record and normalizes artifact paths", async () => {
    const { store } = newStore()
    const result = await recordExperiment(
      store,
      {
        id: "exp-a",
        hypothesis: "long-context retrieval improves recall",
        config: { model: "v4.1-flash", lr: 0.0001 },
        seed: 7,
        datasetHash: "sha256:abc",
        gitSha: "deadbeef",
        command: "python train.py --seed 7",
        metrics: { accuracy: 0.81 },
        status: "completed",
        artifacts: ["logs/run.txt", "/abs/metrics.json", "s3://bucket/ckpt"],
      },
      { baseDir: BASE, now: () => T0 },
    )

    expect(result.created).toBe(true)
    expect(result.experiment).toMatchObject({
      id: "exp-a",
      seed: 7,
      status: "completed",
      cwd: BASE,
      startedAt: T0,
      finishedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    })
    expect(result.experiment.artifacts).toEqual([
      "/work/project/logs/run.txt",
      "/abs/metrics.json",
      "s3://bucket/ckpt",
    ])
  })

  test("merges updates and preserves createdAt", async () => {
    const { store } = newStore()
    await recordExperiment(
      store,
      { id: "exp-a", hypothesis: "h", config: { lr: 0.1 }, metrics: { accuracy: 0.8 }, seed: 1 },
      { baseDir: BASE, now: () => T0 },
    )
    const updated = await recordExperiment(
      store,
      { id: "exp-a", metrics: { f1: 0.7 }, config: { batch: 32 }, status: "failed" },
      { baseDir: BASE, now: () => T1 },
    )

    expect(updated.created).toBe(false)
    expect(updated.experiment.createdAt).toBe(T0)
    expect(updated.experiment.updatedAt).toBe(T1)
    expect(updated.experiment.metrics).toEqual({ accuracy: 0.8, f1: 0.7 })
    expect(updated.experiment.config).toEqual({ lr: 0.1, batch: 32 })
    expect(updated.experiment.status).toBe("failed")
    expect(updated.experiment.finishedAt).toBe(T1)
  })

  test("rejects missing hypotheses, bad metrics, and invalid ids", async () => {
    const { store } = newStore()
    await expect(recordExperiment(store, { hypothesis: "" }, { baseDir: BASE })).rejects.toThrow("hypothesis")
    await expect(
      recordExperiment(store, { hypothesis: "h", metrics: { accuracy: Number.NaN } }, { baseDir: BASE }),
    ).rejects.toThrow("metrics.accuracy")
    await expect(
      recordExperiment(store, { id: "has spaces", hypothesis: "h" }, { baseDir: BASE }),
    ).rejects.toThrow("invalid experiment id")
  })
})

describe("queryExperiments", () => {
  test("filters by status and id, newest first", async () => {
    const { store } = newStore()
    await seed(store, "exp-a", { status: "completed" })
    await seed(store, "exp-b", { status: "failed", metrics: { accuracy: 0.7 } })

    expect((await queryExperiments(store, { status: "completed" })).map((experiment) => experiment.id)).toEqual([
      "exp-a",
    ])
    expect((await queryExperiments(store, { id: "exp-b" })).map((experiment) => experiment.id)).toEqual(["exp-b"])
    expect((await queryExperiments(store, { metric: "accuracy", min: 0.75 })).map((experiment) => experiment.id)).toEqual(
      ["exp-a"],
    )
    expect(await queryExperiments(store, { id: "exp-missing" })).toEqual([])
  })
})

describe("compareExperiments", () => {
  test("computes metric deltas, config diffs, and reproducibility mismatches", async () => {
    const { store } = newStore()
    await seed(store, "exp-a", {
      config: { lr: 0.1 },
      seed: 1,
      datasetHash: "d1",
      gitSha: "g1",
      metrics: { accuracy: 0.8, loss: 1.2 },
    })
    await seed(store, "exp-b", {
      config: { lr: 0.2 },
      seed: 2,
      datasetHash: "d2",
      gitSha: "g1",
      metrics: { accuracy: 0.9 },
    })

    const comparison = await compareExperiments(store, { baseline: "exp-a", candidate: "exp-b" })
    expect(comparison.metrics.accuracy).toMatchObject({ baseline: 0.8, candidate: 0.9 })
    expect(comparison.metrics.accuracy.delta).toBeCloseTo(0.1)
    expect(comparison.metrics.accuracy.pct).toBeCloseTo(12.5)
    expect(comparison.metrics.loss).toMatchObject({ baseline: 1.2, candidate: null, delta: null, pct: null })
    expect(comparison.configDiff.lr).toEqual({ baseline: 0.1, candidate: 0.2 })
    expect(comparison.differences.seed).toEqual({ baseline: 1, candidate: 2 })
    expect(comparison.differences.datasetHash).toEqual({ baseline: "d1", candidate: "d2" })
    expect(comparison.differences.gitSha).toBeUndefined()
  })

  test("rejects missing experiments", async () => {
    const { store } = newStore()
    await seed(store, "exp-a")
    await expect(compareExperiments(store, { baseline: "exp-a", candidate: "exp-missing" })).rejects.toThrow(
      "experiment not found",
    )
  })
})

describe("bestExperiments", () => {
  test("ranks completed runs by metric in both directions", async () => {
    const { store } = newStore()
    await seed(store, "exp-a", { metrics: { accuracy: 0.8 } })
    await seed(store, "exp-b", { metrics: { accuracy: 0.9 } })
    await seed(store, "exp-c", { metrics: { accuracy: 0.85 } })
    await seed(store, "exp-running", { status: "running", metrics: { accuracy: 0.99 } })

    const best = await bestExperiments(store, { metric: "accuracy" })
    expect(best.ranking.map((entry) => entry.experiment.id)).toEqual(["exp-b", "exp-c", "exp-a"])
    expect(best.count).toBe(3)

    const worst = await bestExperiments(store, { metric: "accuracy", mode: "min", limit: 2 })
    expect(worst.ranking.map((entry) => entry.experiment.id)).toEqual(["exp-a", "exp-c"])

    await expect(bestExperiments(store, { metric: "missing" })).rejects.toThrow("no completed experiments")
  })
})

describe("experiment helpers", () => {
  test("normalizes paths and keeps remote URIs", () => {
    expect(normalizeArtifact(BASE, "logs/run.txt")).toBe("/work/project/logs/run.txt")
    expect(normalizeArtifact(BASE, "/abs/run.txt")).toBe("/abs/run.txt")
    expect(normalizeArtifact(BASE, "s3://bucket/run.txt")).toBe("s3://bucket/run.txt")
  })

  test("generates timestamped ids", () => {
    expect(defaultExperimentId(T0)).toMatch(/^exp-20261023000000-[a-z0-9]+$/)
  })
})

describe("createExperimentTools", () => {
  test("wires record and query tools to the shared store", async () => {
    const { store } = newStore()
    const tools = createExperimentTools({
      store,
      baseDir: BASE,
      now: () => T0,
      generateId: () => "exp-tool",
    })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const record = await byName.get("exp_record")!.execute({
      hypothesis: "tool test",
      metrics: { accuracy: 0.5 },
      status: "completed",
    })
    expect(record.metadata).toMatchObject({ id: "exp-tool", status: "completed", created: true })
    expect(JSON.parse(record.content).experiment.id).toBe("exp-tool")

    const query = await byName.get("exp_query")!.execute({})
    expect(JSON.parse(query.content).count).toBe(1)
    expect(query.metadata).toMatchObject({ count: 1 })
  })
})



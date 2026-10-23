import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExperimentStore, type Experiment } from "../plugin/experiments.ts"
import {
  answerHash,
  createVerifyTools,
  verificationReceiptKey,
  verifyClaims,
  type VerifyOptions,
} from "../plugin/verify.ts"

const roots: string[] = []

async function tempDir(label: string) {
  const root = await mkdtemp(join(tmpdir(), `deepseek-${label}-`))
  roots.push(root)
  return root
}

function memoryStorage() {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key: string) {
      return data.get(key)
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
    async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
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

async function setup(label: string) {
  const root = await tempDir(label)
  const storage = memoryStorage()
  const experiments = createExperimentStore(storage, "exp:test")
  const options: VerifyOptions = {
    baseDir: root,
    experiments,
    network: false,
    pythonPath: "python3",
    now: () => "2026-10-23T00:00:00.000Z",
  }
  return { root, storage, experiments, options }
}

function experiment(
  id: string,
  seed: number | undefined,
  accuracy: number,
  extra: Partial<Experiment> = {},
): Experiment {
  return {
    id,
    hypothesis: "same task",
    config: { model: "candidate", lr: 0.1 },
    ...(seed !== undefined ? { seed } : {}),
    datasetHash: "dataset-v1",
    metrics: { accuracy },
    status: "completed",
    artifacts: [],
    cwd: "/work",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...extra,
  }
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe("verify numeric claims", () => {
  test("recomputes a JSON metric and scans the answer", async () => {
    const { root, options } = await setup("verify-number")
    await writeFile(
      join(root, "metrics.json"),
      JSON.stringify({ accuracy: 73.42, loss: { value: 0.271, unit: "nats" } }),
    )
    const result = await verifyClaims(
      {
        answer: "Accuracy reached 73.4% on 3 seeds in 2024.",
        claims: [
          {
            type: "number",
            label: "accuracy",
            value: 73.4,
            source: "metrics.json",
            path: "accuracy",
            tolerance: 0.05,
          },
        ],
      },
      options,
    )
    expect(result.pass).toBe(true)
    expect(result.gate).toBe("ok")
    expect(result.checks.numbers).toBe(1)
    expect(result.evidence[0]).toContain("metrics.json")
    expect(result.answer).toMatchObject({ numbers: 1, unverifiedNumbers: 0 })
  })

  test("fails on a mismatched number and supports JSONL/CSV", async () => {
    const { root, options } = await setup("verify-number-formats")
    await writeFile(join(root, "metrics.jsonl"), '{"accuracy": 81.2}\n{"accuracy": 81.4}\n')
    await writeFile(join(root, "metrics.csv"), "accuracy,loss\n90.1,0.2\n")

    const jsonl = await verifyClaims(
      { claims: [{ type: "number", value: 81.3, source: "metrics.jsonl", path: "accuracy", tolerance: 0.2 }] },
      options,
    )
    expect(jsonl.pass).toBe(true)

    const csv = await verifyClaims(
      { claims: [{ type: "number", value: 90.1, source: "metrics.csv", path: "accuracy" }] },
      options,
    )
    expect(csv.pass).toBe(true)

    const bad = await verifyClaims(
      { claims: [{ type: "number", value: 99.9, source: "metrics.jsonl", path: "accuracy" }] },
      options,
    )
    expect(bad.pass).toBe(false)
    expect(bad.issues[0]).toMatchObject({ type: "metric", severity: "error" })
  })

  test("checks units when the source records them", async () => {
    const { root, options } = await setup("verify-unit")
    await writeFile(join(root, "metrics.json"), JSON.stringify({ loss: { value: 0.271, unit: "nats" } }))
    const ok = await verifyClaims(
      {
        claims: [
          { type: "number", value: 0.271, source: "metrics.json", path: "loss", unit: "nats", requireUnit: true },
        ],
      },
      options,
    )
    expect(ok.pass).toBe(true)

    const bad = await verifyClaims(
      {
        claims: [
          { type: "number", value: 0.271, source: "metrics.json", path: "loss", unit: "bits", requireUnit: true },
        ],
      },
      options,
    )
    expect(bad.pass).toBe(false)
    expect(bad.issues.some((issue) => issue.type === "unit")).toBe(true)
  })

  test("ignores dates and conventional p-value/CI labels", async () => {
    const { options } = await setup("verify-answer-labels")
    const result = await verifyClaims(
      {
        answer: "On 2024-10-23 the gain was 73.4% (p < 0.05, 95% CI).",
        claims: [
          {
            type: "number",
            value: 73.4,
            source: "metrics.json",
            path: "accuracy",
            tolerance: 0.05,
          },
        ],
      },
      options,
    )
    // The source is intentionally missing: the claim itself must fail, but
    // dates and statistical labels must not produce extra answer noise.
    expect(result.issues.some((issue) => issue.type === "unverified-number")).toBe(false)
  })

  test("flags answer numbers without evidence", async () => {
    const { options } = await setup("verify-answer")
    const result = await verifyClaims({ answer: "The gain was 99.9%." }, options)
    expect(result.pass).toBe(false)
    expect(result.issues.map((issue) => issue.type)).toContain("missing-claims")
    expect(result.issues.map((issue) => issue.type)).toContain("unverified-number")
  })
})

describe("verify citations and files", () => {
  test("checks local citations and files", async () => {
    const { root, options } = await setup("verify-path")
    await writeFile(join(root, "paper.md"), "paper")
    await writeFile(join(root, "empty.txt"), "")
    const result = await verifyClaims(
      {
        claims: [
          { type: "citation", source: "paper.md" },
          { type: "file", source: "paper.md" },
          { type: "file", source: "empty.txt" },
        ],
      },
      options,
    )
    expect(result.pass).toBe(true)
    expect(result.issues.some((issue) => issue.detail.includes("empty"))).toBe(true)

    const missing = await verifyClaims(
      { claims: [{ type: "citation", source: "missing.md" }, { type: "file", source: "missing.bin" }] },
      options,
    )
    expect(missing.pass).toBe(false)
    expect(missing.issues.filter((issue) => issue.severity === "error")).toHaveLength(2)
  })

  test("checks URLs through an injected fetcher and respects network=false", async () => {
    const { options } = await setup("verify-citation")
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      return new Response(null, { status: url.includes("missing") ? 404 : 200 })
    }) as typeof fetch
    const live: VerifyOptions = { ...options, network: true, fetchImpl }
    const ok = await verifyClaims(
      { claims: [{ type: "citation", source: "https://example.test/paper" }] },
      live,
    )
    expect(ok.pass).toBe(true)
    expect(ok.evidence[0]).toContain("HTTP 200")

    const bad = await verifyClaims(
      { claims: [{ type: "citation", source: "https://example.test/missing" }] },
      live,
    )
    expect(bad.pass).toBe(false)
    expect(bad.issues[0]).toMatchObject({ type: "citation", severity: "error" })

    const offline = await verifyClaims(
      { claims: [{ type: "citation", source: "https://example.test/paper" }] },
      { ...options, network: false },
    )
    expect(offline.pass).toBe(true)
    expect(offline.issues[0]).toMatchObject({ type: "citation", severity: "warning" })
  })

  test("warns on prose citations and strict mode promotes it", async () => {
    const { options } = await setup("verify-prose-citation")
    const normal = await verifyClaims({ claims: [{ type: "citation", source: "Vaswani et al., 2017" }] }, options)
    expect(normal.pass).toBe(true)
    expect(normal.issues[0]).toMatchObject({ type: "citation", severity: "warning" })
    const strict = await verifyClaims(
      { strict: true, claims: [{ type: "citation", source: "Vaswani et al., 2017" }] },
      options,
    )
    expect(strict.pass).toBe(false)
  })
})

describe("verify experiments", () => {
  test("checks seeds, variance, CI, and baseline fairness", async () => {
    const { options, experiments } = await setup("verify-experiment")
    await experiments.put(experiment("exp-a", 1, 70))
    await experiments.put(experiment("exp-b", 2, 72))
    await experiments.put(experiment("exp-c", 3, 71))
    await experiments.put(
      experiment("exp-base", 1, 68, { config: { model: "baseline", lr: 0.1 }, hypothesis: "baseline task" }),
    )

    const result = await verifyClaims(
      {
        claims: [
          {
            type: "experiment",
            ids: ["exp-a", "exp-b", "exp-c"],
            metric: "accuracy",
            minSeeds: 3,
            maxStd: 2,
            ci: 0.95,
            maxCiWidth: 10,
            baseline: "exp-base",
            requireBaseline: true,
          },
        ],
      },
      options,
    )
    expect(result.pass).toBe(true)
    expect(result.stats?.["claim:0"]).toMatchObject({
      ids: ["exp-a", "exp-b", "exp-c"],
      metric: "accuracy",
      seeds: [1, 2, 3],
      mean: 71,
      baseline: 68,
      delta: 3,
    })
    expect(result.stats?.["claim:0"]?.ci).toHaveLength(2)
    expect(result.issues.some((issue) => issue.type === "baseline" && issue.severity === "warning")).toBe(true)
  })

  test("fails on too few seeds, excessive variance, and dataset mismatch", async () => {
    const { options, experiments } = await setup("verify-experiment-fail")
    await experiments.put(experiment("exp-a", 1, 70))
    await experiments.put(experiment("exp-b", 1, 90))
    await experiments.put(experiment("exp-base", 1, 60, { datasetHash: "dataset-v2", hypothesis: "baseline task" }))

    const result = await verifyClaims(
      {
        claims: [
          {
            type: "experiment",
            ids: ["exp-a", "exp-b"],
            metric: "accuracy",
            minSeeds: 3,
            maxStd: 1,
            baseline: "exp-base",
          },
        ],
      },
      options,
    )
    expect(result.pass).toBe(false)
    expect(result.issues.some((issue) => issue.type === "seed")).toBe(true)
    expect(result.issues.some((issue) => issue.type === "seed-variance")).toBe(true)
    expect(result.issues.some((issue) => issue.type === "baseline" && issue.severity === "error")).toBe(true)
  })
})

describe("verify code", () => {
  test("syntax-checks Python and JSON and reports missing files", async () => {
    const { root, options } = await setup("verify-code")
    await writeFile(join(root, "good.py"), "print('ok')\n")
    await writeFile(join(root, "bad.py"), "print(\n")
    await writeFile(join(root, "good.json"), '{"ok": true}\n')
    await writeFile(join(root, "bad.json"), "{not json\n")

    const good = await verifyClaims(
      {
        claims: [
          { type: "code", source: "good.py" },
          { type: "code", source: "good.json" },
        ],
      },
      options,
    )
    expect(good.pass).toBe(true)

    const bad = await verifyClaims(
      {
        claims: [
          { type: "code", source: "bad.py" },
          { type: "code", source: "bad.json" },
          { type: "code", source: "missing.py" },
        ],
      },
      options,
    )
    expect(bad.pass).toBe(false)
    expect(bad.issues.filter((issue) => issue.type === "code" && issue.severity === "error")).toHaveLength(3)
  })
})

describe("verify receipts", () => {
  test("saves a passing receipt tied to the exact answer", async () => {
    const { root, storage, options } = await setup("verify-receipt")
    await writeFile(join(root, "metrics.json"), JSON.stringify({ accuracy: 73.42 }))
    const tool = createVerifyTools({ ...options, storage, projectID: "proj_test" })[0]!
    const answer = "Accuracy reached 73.4%."
    const result = await tool.execute(
      {
        answer,
        claims: [
          { type: "number", value: 73.4, source: "metrics.json", path: "accuracy", tolerance: 0.05 },
        ],
      },
      { sessionID: "ses_verify" },
    )
    expect(result.metadata).toMatchObject({ pass: true, receiptSaved: true })
    const receipt = storage.data.get(verificationReceiptKey("proj_test", "ses_verify")) as any
    expect(receipt.pass).toBe(true)
    expect(receipt.answerHash).toBe(answerHash(answer))
  })

  test("saves a failing receipt and explains the rewrite gate", async () => {
    const { root, storage, options } = await setup("verify-receipt-fail")
    await writeFile(join(root, "metrics.json"), JSON.stringify({ accuracy: 73.42 }))
    const tool = createVerifyTools({ ...options, storage, projectID: "proj_test" })[0]!
    const result = await tool.execute(
      {
        answer: "Accuracy reached 99.9%.",
        claims: [
          { type: "number", value: 99.9, source: "metrics.json", path: "accuracy" },
        ],
      },
      { sessionID: "ses_fail" },
    )
    expect(result.metadata).toMatchObject({ pass: false, gate: "rewrite", receiptSaved: true })
    const receipt = storage.data.get(verificationReceiptKey("proj_test", "ses_fail")) as any
    expect(receipt.pass).toBe(false)
    expect(receipt.issues.length).toBeGreaterThan(0)
  })
})

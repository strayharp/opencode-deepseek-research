import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { finished } from "node:stream/promises"
import {
  recordExperiment,
  type ExperimentStatus,
  type ExperimentStore,
  type RecordExperimentInput,
} from "./experiments.ts"
import type { PythonKernelManager } from "./kernel.ts"

export interface RunCodeInput {
  code: string
  cwd?: string
  timeoutSec?: number
  cpuSec?: number
  memoryMb?: number
  network?: boolean
  stdin?: string
}

export interface RunCodeOptions {
  baseDir: string
  pythonPath?: string
  runRoot?: string
  timeoutSec?: number
  cpuSec?: number
  memoryMb?: number
  network?: boolean
  outputCapBytes?: number
  previewBytes?: number
  valuePreviewBytes?: number
  experiments?: ExperimentStore
  kernel?: PythonKernelManager
  now?: () => string
}

export interface RunCodeExperiment {
  id: string
  status: ExperimentStatus
}

export interface RunCodeResult {
  ok: boolean
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  cwd: string
  runDir: string
  codePath: string
  scriptPath: string
  configPath: string
  resultPath: string
  stdoutPath: string
  stderrPath: string
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  value?: unknown
  valueTruncated?: boolean
  artifacts: string[]
  experiments: RunCodeExperiment[]
  experimentErrors: string[]
  error?: string
}

export interface RuntimeToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  options: { codemode: false }
  execute: (input: any, context?: any) => Promise<{ content: string; metadata?: Record<string, unknown> }>
}

const DEFAULT_TIMEOUT_SEC = 600
const DEFAULT_CPU_SEC = 60
const DEFAULT_MEMORY_MB = 2_048
const DEFAULT_OUTPUT_CAP = 64 * 1024
const DEFAULT_PREVIEW_BYTES = 2_048
const DEFAULT_VALUE_PREVIEW_BYTES = 4_096

const PYTHON_PRELUDE = String.raw`import json
import os
import socket
import sys
import traceback

try:
    import resource
except ImportError:
    resource = None

with open(sys.argv[1], "r", encoding="utf-8") as _config_file:
    CONFIG = json.load(_config_file)

CODE_PATH = CONFIG["codePath"]
CWD = CONFIG["cwd"]
RESULT_PATH = CONFIG["resultPath"]
CALLS_PATH = CONFIG["callsPath"]
ARTIFACTS_DIR = CONFIG["artifactsDir"]
CPU_SEC = CONFIG.get("cpuSec")
MEMORY_MB = CONFIG.get("memoryMb")
NETWORK = bool(CONFIG.get("network"))

os.makedirs(ARTIFACTS_DIR, exist_ok=True)
os.chdir(CWD)

if resource is not None:
    try:
        if CPU_SEC:
            resource.setrlimit(resource.RLIMIT_CPU, (int(CPU_SEC), int(CPU_SEC)))
        if MEMORY_MB:
            limit = int(MEMORY_MB) * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception:
        # RLIMIT_AS is not enforceable on every platform (notably macOS); the
        # wall-clock limit and output cap still apply.
        pass

if not NETWORK:
    _connect = socket.socket.connect
    _connect_ex = socket.socket.connect_ex

    def _blocked_connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            raise RuntimeError("network disabled by run_code; pass network=true to allow")
        return _connect(self, address)

    def _blocked_connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            raise RuntimeError("network disabled by run_code; pass network=true to allow")
        return _connect_ex(self, address)

    socket.socket.connect = _blocked_connect
    socket.socket.connect_ex = _blocked_connect_ex

    def _blocked_create_connection(*args, **kwargs):
        raise RuntimeError("network disabled by run_code; pass network=true to allow")

    socket.create_connection = _blocked_create_connection

artifacts = []
calls_file = open(CALLS_PATH, "a", encoding="utf-8")


def _jsonable(value, depth=0):
    if depth > 5:
        return repr(value)[:2000]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    module = type(value).__module__
    if module.startswith("numpy"):
        try:
            import numpy as np
            if isinstance(value, np.ndarray):
                flat = value.reshape(-1)
                return {
                    "__type__": "ndarray",
                    "shape": list(value.shape),
                    "dtype": str(value.dtype),
                    "head": [_jsonable(v, depth + 1) for v in flat[:10]],
                }
            if isinstance(value, np.generic):
                return value.item()
        except Exception:
            pass
    if module.startswith("pandas"):
        try:
            import pandas as pd
            if isinstance(value, pd.DataFrame):
                return {
                    "__type__": "dataframe",
                    "shape": list(value.shape),
                    "columns": [str(c) for c in list(value.columns)[:50]],
                    "head": _jsonable(value.head(3).to_dict(orient="records"), depth + 1),
                }
            if isinstance(value, pd.Series):
                return {
                    "__type__": "series",
                    "shape": list(value.shape),
                    "name": str(value.name),
                    "head": _jsonable(value.head(10).tolist(), depth + 1),
                }
        except Exception:
            pass
    if module.startswith("torch"):
        try:
            import torch
            if isinstance(value, torch.Tensor):
                return {
                    "__type__": "tensor",
                    "shape": list(value.shape),
                    "dtype": str(value.dtype),
                    "device": str(value.device),
                    "head": _jsonable(value.detach().flatten()[:10].cpu().tolist(), depth + 1),
                }
        except Exception:
            pass
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in list(value)[:100]]
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in list(value.items())[:100]}
    return repr(value)[:2000]


class _Tools:
    cwd = CWD
    artifacts_dir = ARTIFACTS_DIR

    def result(self, value):
        global _tools_result
        _tools_result = value
        return value

    def artifact(self, path):
        value = str(path)
        if not os.path.isabs(value):
            value = os.path.abspath(os.path.join(CWD, value))
        artifacts.append(value)
        return value

    def savefig(self, name="figure.png", dpi=150, **kwargs):
        import matplotlib.pyplot as plt
        value = str(name)
        if not os.path.isabs(value):
            value = os.path.join(ARTIFACTS_DIR, os.path.basename(value))
        os.makedirs(os.path.dirname(value), exist_ok=True)
        plt.savefig(value, dpi=dpi, bbox_inches="tight", **kwargs)
        artifacts.append(value)
        return value

    def exp_record(self, **kwargs):
        kwargs.setdefault("artifacts", list(artifacts))
        try:
            line = json.dumps({"type": "exp_record", "input": kwargs}, ensure_ascii=False, default=str)
        except Exception:
            line = json.dumps(
                {"type": "exp_record", "input": {"hypothesis": "run_code experiment", "metrics": {}, "artifacts": list(artifacts)}},
                ensure_ascii=False,
            )
        calls_file.write(line + "\n")
        calls_file.flush()
        return kwargs


tools = _Tools()
_tools_result = None
namespace = {"__name__": "__main__", "tools": tools, "os": os, "sys": sys}
exit_code = 0
ok = True
error = None

try:
    with open(CODE_PATH, "r", encoding="utf-8") as code_file:
        source = code_file.read()
    exec(compile(source, CODE_PATH, "exec"), namespace, namespace)
except SystemExit as exc:
    code = exc.code
    exit_code = int(code) if isinstance(code, int) else (0 if code is None else 1)
    if exit_code != 0:
        ok = False
        error = "SystemExit(%r)" % (code,)
except BaseException:
    ok = False
    exit_code = 1
    error = traceback.format_exc()
    traceback.print_exc()
finally:
    try:
        calls_file.close()
    except Exception:
        pass
    if _tools_result is not None:
        value = _tools_result
    elif "result" in namespace:
        value = namespace["result"]
    else:
        value = None
    payload = {"ok": ok, "value": _jsonable(value), "artifacts": artifacts}
    if error is not None:
        payload["error"] = error[-4000:]
    try:
        temporary = RESULT_PATH + ".tmp"
        with open(temporary, "w", encoding="utf-8") as result_file:
            json.dump(payload, result_file, ensure_ascii=False, default=str)
        os.replace(temporary, RESULT_PATH)
    except Exception:
        traceback.print_exc()
        sys.exit(2)

sys.exit(exit_code)
`

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "run"
}

function normalizeCwd(baseDir: string, value: string | undefined): string {
  if (!value) return baseDir
  if (value === "~") return process.env.HOME || baseDir
  if (value.startsWith("~/")) return resolve(process.env.HOME || baseDir, value.slice(2))
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The process may already be gone.
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function readPreview(path: string, limit: number): Promise<{ text: string; truncated: boolean }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return { text: "", truncated: false }
  }
  if (text.length <= limit) return { text, truncated: false }
  const head = Math.max(1, Math.floor(limit * 0.55))
  const tail = Math.max(1, limit - head)
  return {
    text: `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`,
    truncated: true,
  }
}

function previewValue(value: unknown, limit: number, path: string): { value?: unknown; truncated: boolean } {
  if (value === undefined) return { truncated: false }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { value: { truncated: true, path, note: "value is not JSON-serializable" }, truncated: true }
  }
  if (serialized === undefined || serialized.length <= limit) return { value, truncated: false }
  return {
    value: {
      truncated: true,
      chars: serialized.length,
      head: serialized.slice(0, Math.floor(limit * 0.6)),
      tail: serialized.slice(-Math.floor(limit * 0.3)),
      path,
    },
    truncated: true,
  }
}

async function readExperimentCalls(
  callsPath: string,
  store: ExperimentStore | undefined,
  context: { cwd: string; pythonPath: string; scriptPath: string; runDir: string; ok: boolean; now?: () => string },
): Promise<{ experiments: RunCodeExperiment[]; errors: string[] }> {
  const experiments: RunCodeExperiment[] = []
  const errors: string[] = []
  if (!store) return { experiments, errors }

  let text: string
  try {
    text = await readFile(callsPath, "utf8")
  } catch {
    return { experiments, errors }
  }

  for (const line of text.split("\n").slice(0, 100)) {
    if (!line.trim()) continue
    let call: unknown
    try {
      call = JSON.parse(line)
    } catch {
      errors.push("invalid experiment call JSON")
      continue
    }
    if (typeof call !== "object" || call === null) {
      errors.push("invalid experiment call")
      continue
    }
    const record = call as { type?: unknown; input?: unknown }
    if (record.type !== "exp_record" || typeof record.input !== "object" || record.input === null) continue
    const input = { ...(record.input as Record<string, unknown>) } as RecordExperimentInput
    if (!input.hypothesis) input.hypothesis = "run_code experiment"
    if (!input.command) input.command = `${context.pythonPath} -I ${context.scriptPath}`
    if (!input.cwd) input.cwd = context.cwd
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) input.config = {}
    input.config = { ...input.config, runCode: true, runDir: context.runDir }
    if (!input.status) input.status = context.ok ? "completed" : "failed"
    try {
      const result = await recordExperiment(store, input, { baseDir: context.cwd, now: context.now })
      experiments.push({ id: result.experiment.id, status: result.experiment.status })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { experiments, errors }
}

export async function runCode(input: RunCodeInput, options: RunCodeOptions, context?: any): Promise<RunCodeResult> {
  const code = input.code
  if (typeof code !== "string" || !code.trim()) throw new Error("code must be a non-empty string")

  const baseDir = options.baseDir
  const cwd = normalizeCwd(baseDir, input.cwd)
  const pythonPath = options.pythonPath || process.env.PYTHON || "python3"
  const timeoutSec = clampInt(input.timeoutSec, options.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1, 3_600)
  const cpuSec = clampInt(input.cpuSec, options.cpuSec ?? DEFAULT_CPU_SEC, 1, 3_600)
  const memoryMb = clampInt(input.memoryMb, options.memoryMb ?? DEFAULT_MEMORY_MB, 64, 65_536)
  const network = input.network ?? options.network ?? false
  const outputCap = Math.max(1_024, options.outputCapBytes ?? DEFAULT_OUTPUT_CAP)
  const previewBytes = Math.max(256, options.previewBytes ?? DEFAULT_PREVIEW_BYTES)
  const valuePreviewBytes = Math.max(512, options.valuePreviewBytes ?? DEFAULT_VALUE_PREVIEW_BYTES)
  const runRoot = options.runRoot ?? join(tmpdir(), "opencode-deepseek-research", "runs")
  const sessionID = safeSegment(String(context?.sessionID ?? "no-session"))
  const callID = safeSegment(String(context?.id ?? `run-${Date.now().toString(36)}`))
  const runDir = join(runRoot, sessionID, callID)
  const artifactsDir = join(runDir, "artifacts")
  const codePath = join(runDir, "code.py")
  const scriptPath = options.kernel?.runnerPath ?? join(runDir, "runner.py")
  const configPath = join(runDir, "config.json")
  const resultPath = join(runDir, "result.json")
  const callsPath = join(runDir, "experiments.jsonl")
  const stdoutPath = join(runDir, "stdout.txt")
  const stderrPath = join(runDir, "stderr.txt")

  await mkdir(artifactsDir, { recursive: true, mode: 0o700 })
  await writeFile(codePath, code, { encoding: "utf8", mode: 0o600 })
  await writeFile(callsPath, "", { encoding: "utf8", mode: 0o600 })
  if (!options.kernel) {
    await writeFile(scriptPath, PYTHON_PRELUDE, { encoding: "utf8", mode: 0o600 })
  }
  await writeFile(
    configPath,
    JSON.stringify(
      {
        codePath,
        cwd,
        resultPath,
        callsPath,
        artifactsDir,
        scriptPath,
        kernel: options.kernel ? "persistent" : "fresh",
        cpuSec,
        memoryMb,
        network,
        outputCapBytes: outputCap,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  )

  const startedAt = Date.now()
  if (options.kernel) {
    let response: {
      ok: boolean
      exitCode: number | null
      timedOut: boolean
      error?: string
      stdoutBytes?: number
      stderrBytes?: number
      stdoutTruncated?: boolean
      stderrTruncated?: boolean
    }
    try {
      response = await options.kernel.execute(
        sessionID,
        {
          id: callID,
          codePath,
          cwd,
          artifactsDir,
          resultPath,
          callsPath,
          stdoutPath,
          stderrPath,
          network,
          outputCapBytes: outputCap,
        },
        timeoutSec * 1_000,
      )
    } catch (error) {
      response = {
        ok: false,
        exitCode: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const stdoutPreview = await readPreview(stdoutPath, previewBytes)
    const stderrPreview = await readPreview(stderrPath, previewBytes)
    let payload: any = undefined
    try {
      payload = JSON.parse(await readFile(resultPath, "utf8"))
    } catch {
      payload = undefined
    }
    const durationMs = Date.now() - startedAt
    const ok = !response.timedOut && response.ok && payload?.ok !== false
    const value = previewValue(payload?.value, valuePreviewBytes, resultPath)
    const artifacts = Array.isArray(payload?.artifacts)
      ? payload.artifacts.filter((value: unknown): value is string => typeof value === "string")
      : []
    const callResult = await readExperimentCalls(callsPath, options.experiments, {
      cwd,
      pythonPath,
      scriptPath,
      runDir,
      ok,
      now: options.now,
    })
    return {
      ok,
      exitCode: response.exitCode,
      signal: null,
      timedOut: response.timedOut,
      durationMs,
      cwd,
      runDir,
      codePath,
      scriptPath,
      configPath,
      resultPath,
      stdoutPath,
      stderrPath,
      stdout: stdoutPreview.text,
      stderr: stderrPreview.text,
      stdoutBytes: response.stdoutBytes ?? (await fileSize(stdoutPath)),
      stderrBytes: response.stderrBytes ?? (await fileSize(stderrPath)),
      stdoutTruncated: response.stdoutTruncated === true || stdoutPreview.truncated,
      stderrTruncated: response.stderrTruncated === true || stderrPreview.truncated,
      ...(value.value !== undefined ? { value: value.value } : {}),
      ...(value.truncated ? { valueTruncated: true } : {}),
      artifacts,
      experiments: callResult.experiments,
      experimentErrors: callResult.errors,
      ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
      ...(response.error ? { error: response.error } : {}),
    }
  }

  const stdoutStream = createWriteStream(stdoutPath, { mode: 0o600 })
  const stderrStream = createWriteStream(stderrPath, { mode: 0o600 })
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutTruncated = false
  let stderrTruncated = false

  const child = spawn(pythonPath, ["-I", scriptPath, configPath], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    const before = stdoutBytes
    stdoutBytes += chunk.length
    const remaining = outputCap - before
    if (remaining > 0) stdoutStream.write(chunk.subarray(0, remaining))
    if (stdoutBytes > outputCap) stdoutTruncated = true
  })
  child.stdout?.on("end", () => stdoutStream.end())
  child.stderr?.on("data", (chunk: Buffer) => {
    const before = stderrBytes
    stderrBytes += chunk.length
    const remaining = outputCap - before
    if (remaining > 0) stderrStream.write(chunk.subarray(0, remaining))
    if (stderrBytes > outputCap) stderrTruncated = true
  })
  child.stderr?.on("end", () => stderrStream.end())
  child.stdin?.on("error", () => {})
  if (typeof input.stdin === "string") child.stdin?.end(input.stdin)
  else child.stdin?.end()

  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined
  const wallTimer = setTimeout(() => {
    timedOut = true
    killProcessGroup(child, "SIGTERM")
    killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000)
  }, timeoutSec * 1_000)

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolveExit) => {
    let settled = false
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return
      settled = true
      resolveExit(value)
    }
    child.once("error", (error) => {
      setTimeout(() => finish({ code: null, signal: null, error }), 50)
    })
    child.once("close", (code, signal) => finish({ code, signal }))
  })

  clearTimeout(wallTimer)
  if (killTimer) clearTimeout(killTimer)
  if (exit.error) {
    stdoutStream.destroy()
    stderrStream.destroy()
  }
  const settle = (stream: WriteStream) =>
    Promise.race([finished(stream), new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000))])
  await Promise.allSettled([settle(stdoutStream), settle(stderrStream)])

  const stdoutPreview = await readPreview(stdoutPath, previewBytes)
  const stderrPreview = await readPreview(stderrPath, previewBytes)
  let payload: any = undefined
  try {
    payload = JSON.parse(await readFile(resultPath, "utf8"))
  } catch {
    payload = undefined
  }

  const durationMs = Date.now() - startedAt
  const ok = !timedOut && exit.error === undefined && exit.code === 0 && payload?.ok !== false
  const value = previewValue(payload?.value, valuePreviewBytes, resultPath)
  const artifacts = Array.isArray(payload?.artifacts)
    ? payload.artifacts.filter((value: unknown): value is string => typeof value === "string")
    : []
  const callResult = await readExperimentCalls(callsPath, options.experiments, {
    cwd,
    pythonPath,
    scriptPath,
    runDir,
    ok,
    now: options.now,
  })

  return {
    ok,
    exitCode: exit.code,
    signal: exit.signal ?? null,
    timedOut,
    durationMs,
    cwd,
    runDir,
    codePath,
    scriptPath,
    configPath,
    resultPath,
    stdoutPath,
    stderrPath,
    stdout: stdoutPreview.text,
    stderr: stderrPreview.text,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutTruncated || stdoutPreview.truncated,
    stderrTruncated: stderrTruncated || stderrPreview.truncated,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(value.truncated ? { valueTruncated: true } : {}),
    artifacts,
    experiments: callResult.experiments,
    experimentErrors: callResult.errors,
    ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
    ...(exit.error ? { error: exit.error.message } : {}),
  }
}

const runCodeInputSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "Python source executed in the configured runtime (fresh process by default, or a persistent per-session kernel when runCodeKernel=persistent). Use tools.result(value), tools.exp_record(**kwargs), tools.artifact(path), and tools.savefig(name).",
    },
    cwd: { type: "string", description: "Working directory, relative to the project unless absolute." },
    timeoutSec: { type: "integer", minimum: 1, maximum: 3_600, description: "Wall-clock limit (default 600s)." },
    cpuSec: { type: "integer", minimum: 1, maximum: 3_600, description: "CPU limit (default 60s)." },
    memoryMb: { type: "integer", minimum: 64, maximum: 65_536, description: "Address-space limit (default 2048 MB)." },
    network: { type: "boolean", description: "Allow outbound network (default false; advisory socket guard)." },
    stdin: { type: "string", description: "Optional stdin for the process." },
  },
  required: ["code"],
  additionalProperties: false,
}

export function createRunCodeTools(options: RunCodeOptions): RuntimeToolDefinition[] {
  return [
    {
      name: "run_code",
      description:
        "Run a Python fragment in a fresh isolated CPython process or an opt-in persistent per-session kernel. Returns a compact JSON result: value, bounded stdout/stderr previews, artifact paths, full-output paths, and any experiments recorded through tools.exp_record. Persistent mode keeps imports and variables across calls; fresh mode is the default. Network is blocked by default; wall limits apply.",
      input: runCodeInputSchema,
      options: { codemode: false },
      execute: async (input: RunCodeInput, context?: any) => {
        const result = await runCode(input, options, context)
        return {
          content: JSON.stringify(result, null, 2),
          metadata: {
            ok: result.ok,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            artifacts: result.artifacts.length,
            experiments: result.experiments.length,
          },
        }
      },
    },
  ]
}

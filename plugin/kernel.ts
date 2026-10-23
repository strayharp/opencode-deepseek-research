import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface, type Interface } from "node:readline"

export interface KernelRequest {
  id: string
  codePath: string
  cwd: string
  artifactsDir: string
  resultPath: string
  callsPath: string
  stdoutPath: string
  stderrPath: string
  network: boolean
  outputCapBytes: number
}

export interface KernelResponse {
  id: string
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  error?: string
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface PythonKernelManager {
  readonly runnerPath: string
  execute(sessionID: string, request: KernelRequest, timeoutMs: number): Promise<KernelResponse>
  close(): Promise<void>
}

export interface PythonKernelOptions {
  pythonPath?: string
  memoryMb?: number
  rootDir?: string
}

const KERNEL_RUNNER = String.raw`import contextlib
import json
import os
import socket
import sys
import traceback

try:
    import resource
except ImportError:
    resource = None

MEMORY_MB = int(sys.argv[1]) if len(sys.argv) > 1 else 2048
if resource is not None:
    try:
        limit = MEMORY_MB * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception:
        pass

ALLOW_NETWORK = False
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_create_connection = socket.create_connection


def _blocked_connect(self, address):
    if not ALLOW_NETWORK and self.family in (socket.AF_INET, socket.AF_INET6):
        raise RuntimeError("network disabled by run_code; pass network=true to allow")
    return _connect(self, address)


def _blocked_connect_ex(self, address):
    if not ALLOW_NETWORK and self.family in (socket.AF_INET, socket.AF_INET6):
        raise RuntimeError("network disabled by run_code; pass network=true to allow")
    return _connect_ex(self, address)


socket.socket.connect = _blocked_connect
socket.socket.connect_ex = _blocked_connect_ex


def _blocked_create_connection(*args, **kwargs):
    if not ALLOW_NETWORK:
        raise RuntimeError("network disabled by run_code; pass network=true to allow")
    return _create_connection(*args, **kwargs)


socket.create_connection = _blocked_create_connection

CWD = None
ARTIFACTS_DIR = None
artifacts = []
calls_file = None
_tools_result = None


class _CappedWriter:
    def __init__(self, file, limit):
        self.file = file
        self.limit = max(1, int(limit))
        self.bytes = 0
        self.truncated = False

    def write(self, value):
        if not isinstance(value, str):
            value = str(value)
        data = value.encode("utf-8", "replace")
        if self.bytes < self.limit:
            remaining = self.limit - self.bytes
            self.file.write(data[:remaining].decode("utf-8", "replace"))
        self.bytes += len(data)
        if self.bytes > self.limit:
            self.truncated = True
        return len(value)

    def flush(self):
        self.file.flush()

    def close(self):
        self.file.close()

    @property
    def buffer(self):
        return self.file.buffer

    @property
    def encoding(self):
        return "utf-8"

    @property
    def errors(self):
        return "replace"

    def isatty(self):
        return False


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
    cwd = None
    artifacts_dir = None

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
        if calls_file is not None:
            calls_file.write(line + "\n")
            calls_file.flush()
        return kwargs


tools = _Tools()
namespace = {"__name__": "__main__", "tools": tools, "os": os, "sys": sys}
protocol = sys.__stdout__


def send(payload):
    protocol.write(json.dumps(payload, ensure_ascii=False) + "\n")
    protocol.flush()


send({"ready": True})

for line in sys.__stdin__:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except Exception:
        send({"error": "invalid kernel request"})
        continue
    if request.get("type") == "shutdown":
        send({"shutdown": True})
        break

    request_id = request.get("id")
    stdout_file = None
    stderr_file = None
    stdout_writer = None
    stderr_writer = None
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    calls_file = None
    ok = True
    exit_code = 0
    error = None
    try:
        stdout_file = open(request["stdoutPath"], "w", encoding="utf-8")
        stderr_file = open(request["stderrPath"], "w", encoding="utf-8")
        stdout_writer = _CappedWriter(stdout_file, request.get("outputCapBytes", 65536))
        stderr_writer = _CappedWriter(stderr_file, request.get("outputCapBytes", 65536))
        sys.stdout = stdout_writer
        sys.stderr = stderr_writer
        ALLOW_NETWORK = bool(request.get("network"))
        CWD = request["cwd"]
        ARTIFACTS_DIR = request["artifactsDir"]
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        os.chdir(CWD)
        tools.cwd = CWD
        tools.artifacts_dir = ARTIFACTS_DIR
        artifacts.clear()
        _tools_result = None
        namespace.pop("result", None)
        calls_file = open(request["callsPath"], "a", encoding="utf-8")
        with open(request["codePath"], "r", encoding="utf-8") as code_file:
            source = code_file.read()
        exec(compile(source, request["codePath"], "exec"), namespace, namespace)
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
        try:
            traceback.print_exc()
        except Exception:
            pass
    finally:
        if calls_file is not None:
            try:
                calls_file.close()
            except Exception:
                pass
        value = _tools_result if _tools_result is not None else namespace.get("result")
        payload = {"ok": ok, "value": _jsonable(value), "artifacts": list(artifacts)}
        if error is not None:
            payload["error"] = error[-4000:]
        try:
            temporary = request["resultPath"] + ".tmp"
            with open(temporary, "w", encoding="utf-8") as result_file:
                json.dump(payload, result_file, ensure_ascii=False, default=str)
            os.replace(temporary, request["resultPath"])
        except Exception:
            ok = False
            error = "failed to write kernel result"
        try:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            if stdout_writer is not None:
                stdout_writer.flush()
                stdout_writer.close()
            if stderr_writer is not None:
                stderr_writer.flush()
                stderr_writer.close()
        except Exception:
            pass
        send(
            {
                "id": request_id,
                "ok": ok,
                "exitCode": exit_code,
                "stdoutBytes": stdout_writer.bytes if stdout_writer is not None else 0,
                "stderrBytes": stderr_writer.bytes if stderr_writer is not None else 0,
                "stdoutTruncated": bool(stdout_writer.truncated) if stdout_writer is not None else False,
                "stderrTruncated": bool(stderr_writer.truncated) if stderr_writer is not None else False,
                **({"error": error} if error is not None else {}),
            }
        )
`

interface Pending {
  resolve: (response: KernelResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface KernelProcess {
  child: ChildProcess
  lines: Interface
  ready: Promise<void>
  pending: Map<string, Pending>
  stderr: string
  startResolve: () => void
  startReject: (error: Error) => void
  closed: boolean
  queue: Promise<unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPythonKernelManager(options: PythonKernelOptions = {}): PythonKernelManager {
  const pythonPath = options.pythonPath || process.env.PYTHON || "python3"
  const memoryMb = Math.max(64, Math.floor(options.memoryMb ?? 2_048))
  const rootDir = options.rootDir ?? join(tmpdir(), "opencode-deepseek-research", "kernels")
  const runnerPath = join(rootDir, "kernel.py")
  const kernels = new Map<string, KernelProcess>()
  let readyPromise: Promise<void> | undefined
  let closed = false

  async function ensureRunner(): Promise<void> {
    if (!readyPromise) {
      readyPromise = (async () => {
        await mkdir(rootDir, { recursive: true, mode: 0o700 })
        await writeFile(runnerPath, KERNEL_RUNNER, { encoding: "utf8", mode: 0o600 })
      })()
    }
    return readyPromise
  }

  function removeKernel(sessionID: string, kernel: KernelProcess): void {
    if (kernels.get(sessionID) === kernel) kernels.delete(sessionID)
  }

  function failPending(kernel: KernelProcess, error: Error): void {
    kernel.closed = true
    for (const [id, pending] of kernel.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      kernel.pending.delete(id)
    }
    kernel.startReject(error)
  }

  function startKernel(sessionID: string): KernelProcess {
    const child = spawn(pythonPath, ["-I", runnerPath, String(memoryMb)], {
      cwd: rootDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let startResolve!: () => void
    let startReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      startResolve = resolve
      startReject = reject
    })
    const kernel: KernelProcess = {
      child,
      lines: createInterface({ input: child.stdout! }),
      ready,
      pending: new Map(),
      stderr: "",
      startResolve,
      startReject,
      closed: false,
      queue: Promise.resolve(),
    }
    kernel.lines.on("line", (line) => {
      let value: any
      try {
        value = JSON.parse(line)
      } catch {
        return
      }
      if (value?.ready === true) {
        kernel.startResolve()
        return
      }
      const id = typeof value?.id === "string" ? value.id : undefined
      if (!id) return
      const pending = kernel.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      kernel.pending.delete(id)
      pending.resolve({
        id,
        ok: value.ok === true,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        timedOut: false,
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(typeof value.stdoutBytes === "number" ? { stdoutBytes: value.stdoutBytes } : {}),
        ...(typeof value.stderrBytes === "number" ? { stderrBytes: value.stderrBytes } : {}),
        ...(value.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
        ...(value.stderrTruncated === true ? { stderrTruncated: true } : {}),
      })
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (kernel.stderr.length < 16_384) kernel.stderr += chunk.toString("utf8").slice(0, 16_384 - kernel.stderr.length)
    })
    child.once("error", (error) => {
      failPending(kernel, error instanceof Error ? error : new Error(String(error)))
      removeKernel(sessionID, kernel)
    })
    child.once("close", () => {
      if (!kernel.closed) {
        const suffix = kernel.stderr.trim() ? `: ${kernel.stderr.trim().slice(-1_000)}` : ""
        failPending(kernel, new Error(`Python kernel exited${suffix}`))
      }
      kernel.lines.close()
      removeKernel(sessionID, kernel)
    })
    return kernel
  }

  async function getKernel(sessionID: string): Promise<KernelProcess> {
    await ensureRunner()
    const existing = kernels.get(sessionID)
    if (existing && !existing.closed) {
      await existing.ready
      return existing
    }
    const kernel = startKernel(sessionID)
    kernels.set(sessionID, kernel)
    await kernel.ready
    return kernel
  }

  function killKernel(kernel: KernelProcess): void {
    kernel.closed = true
    try {
      kernel.child.kill("SIGTERM")
    } catch {
      // Already gone.
    }
    setTimeout(() => {
      try {
        kernel.child.kill("SIGKILL")
      } catch {
        // Already gone.
      }
    }, 500).unref?.()
  }

  async function executeOne(sessionID: string, request: KernelRequest, timeoutMs: number): Promise<KernelResponse> {
    const kernel = await getKernel(sessionID)
    return new Promise<KernelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        kernel.pending.delete(request.id)
        killKernel(kernel)
        resolve({
          id: request.id,
          ok: false,
          exitCode: null,
          timedOut: true,
          error: `Python kernel timed out after ${Math.round(timeoutMs / 1_000)}s`,
        })
      }, Math.max(1, timeoutMs))
      kernel.pending.set(request.id, { resolve, reject, timer })
      try {
        kernel.child.stdin?.write(JSON.stringify(request) + "\n")
      } catch (error) {
        clearTimeout(timer)
        kernel.pending.delete(request.id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    runnerPath,
    async execute(sessionID, request, timeoutMs) {
      if (closed) throw new Error("Python kernel manager is closed")
      const kernel = await getKernel(sessionID)
      const run = kernel.queue.then(() => executeOne(sessionID, request, timeoutMs))
      kernel.queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
    async close() {
      if (closed) return
      closed = true
      const all = [...kernels.values()]
      kernels.clear()
      for (const kernel of all) {
        try {
          kernel.child.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n")
        } catch {
          // Ignore.
        }
      }
      await Promise.all(
        all.map(
          (kernel) =>
            new Promise<void>((resolve) => {
              if (kernel.closed) return resolve()
              const timer = setTimeout(() => {
                killKernel(kernel)
                resolve()
              }, 500)
              kernel.child.once("close", () => {
                clearTimeout(timer)
                resolve()
              })
            }),
        ),
      )
    },
  }
}

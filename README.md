# opencode-deepseek-research

OpenCode V2 plugin for DeepSeek V4.1 Flash 1017 research workflows, scoped for
literature review, research-gap finding, brainstorming, initial code scaffolding,
result analysis, and data visualization.

Experiments that need GPUs or long runtimes are expected to run on your Linux
server, outside OpenCode. This plugin deliberately does **not** manage local
background jobs, SLURM, Kubernetes, SSH jobs, or GPU allocation.

## What it does

- Injects a research-mode system block (citations, recomputation, seed/config
  tracking, correlation vs causation).
- Routes reasoning effort per agent: `scout`/`writer` low,
  `experimenter`/`analyst` high, `critic` max.
- Caps output tokens per agent to avoid the model's verbose default.
- Uses a research-specific compaction prompt so evidence, experiment config, and
  open questions survive context compression.
- Audits prompt-cache hit rate from `session.usage.updated`; stores per-session
  stats and warns once when a large session falls below the threshold.
- Spills oversized tool results to a private temp file and leaves a bounded
  preview plus the spill path in context.
- Adds a project-scoped experiment registry: `exp_record`, `exp_query`,
  `exp_compare`, `exp_best`.
- Runs Python fragments through `run_code`, either in a fresh CPython process
  (default) or an opt-in persistent per-session kernel, with `tools.result`,
  `tools.artifact`, `tools.savefig`, and `tools.exp_record`.
- Adds a `verify` tool for deterministic claim checks: numeric recomputation
  from JSON/JSONL/CSV or experiment metrics, citation/path checks, unit checks,
  seed variance/CI, baseline fairness, and Python/JSON/Bash/JS syntax checks.
- Gates final answers: when a completed root-session answer contains numbers or
  citations but no matching passing `verify` receipt, the plugin injects one
  synthetic rewrite request.
- Adds a `best_of_n` tool for high-value tasks: 3–5 independent child sessions
  solve the same task, an optional judge ranks them, and the tool returns the
  best answer plus disagreements. It runs synchronously by default and can run
  in the background with `best_of_n_status` / `best_of_n_cancel`.
- Registers five research agent presets (`scout`, `experimenter`, `analyst`,
  `critic`, `writer`), five auto-invokable skills, and five slash commands
  (`/lit`, `/prereg`, `/ablate`, `/verify`, `/paper`).
- Adds a persisted USD/token `cost_report` panel grouped by task, session,
  agent, or model, plus an optional USD budget guard. Blocked model requests are
  routed to a local 402 endpoint.

## Fit for this workflow

| Task | Relevant features |
|---|---|
| Literature review | research rules, `/lit`, paper-reading skill, compaction, spill, `verify` citations, cost panel |
| Research-gap finding | `/lit`, scout/critic presets, compaction, `verify`, optional `best_of_n` |
| Brainstorming | critic/scout presets, output budget, cost panel, optional `best_of_n` |
| Initial code scaffolding | `run_code`, `verify` code syntax, `exp_record`, shell/read/write |
| Result analysis | `run_code`, `exp_compare`/`exp_best`, `verify` numbers, statistics skill |
| Data visualization | `run_code` + matplotlib, `tools.savefig`, artifact paths |

## Install locally

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-deepseek-research",
      "options": {
        "toolResultLimit": 32000,
        "cacheMinPromptTokens": 200000,
        "cacheMinHitRate": 0.5,
        "pythonPath": "python3",
        "runCodeTimeoutSec": 600,
        "runCodeCpuSec": 60,
        "runCodeMemoryMb": 2048,
        "runCodeNetwork": false,
        "runCodeKernel": "persistent",
        "verifyNetwork": true,
        "verifyGate": true,
        "verifyMaxGates": 1,
        "bestOfN": true,
        "bestOfNMaxCandidates": 5,
        "bestOfNTimeoutSec": 600,
        "bestOfNJudge": true,
        "bestOfNJudgeTimeoutSec": 180,
        "bestOfNNotify": true,
        "agentPresets": true,
        "researchSkills": true,
        "researchCommands": true,
        "budgetUSD": 0,
        "budgetScope": "project",
        "budgetNotify": true
      }
    }
  ]
}
```

`index.ts` is the package entrypoint OpenCode resolves; it re-exports
`plugin/index.ts`. A relative `"./opencode-deepseek-research"` path also works
when the package sits next to the config file.

## Experiment registry

| Tool | Purpose |
|---|---|
| `exp_record` | Create/update a run: hypothesis, config, seed, dataset hash, git SHA, command, metrics, status, artifact paths |
| `exp_query` | Query by id, status, or metric range; newest first |
| `exp_compare` | Metric deltas/percent changes, config diffs, seed/dataset/git mismatches |
| `exp_best` | Rank `completed` runs by a metric, max or min |

Records are stored in OpenCode's plugin KV store under the current project id.
Relative artifact paths are normalized against the project directory; absolute
paths and URI-style paths (`s3://`, `wandb://`) are preserved.

Recording is manual: the plugin no longer auto-records shell commands. Use
`exp_record` after a Linux-server run, or let `run_code` call
`tools.exp_record(...)` for local analysis experiments.

## Python runtime

`run_code` executes a Python fragment in a fresh `python3 -I` process by default.
Set `runCodeKernel: "persistent"` to reuse a per-session Python kernel across
calls: variables, imports, and loaded data survive. Persistent mode still has a
per-call wall timeout; a timeout kills the kernel and the next call starts a new
one. Memory is capped at kernel start; `cpuSec` is enforced only in fresh mode.
It is meant for short analysis, evaluation, and plotting, not long training.

```python
import pandas as pd
import matplotlib.pyplot as plt

frame = pd.read_csv("runs/data.csv")
accuracy = float((frame.pred == frame.label).mean())
fig, ax = plt.subplots()
ax.plot(frame.x, frame.y)
plot = tools.savefig("fit.png")
tools.exp_record(
    hypothesis="linear fit improves accuracy",
    metrics={"accuracy": accuracy},
    artifacts=[plot],
)
result = {"accuracy": accuracy, "rows": len(frame)}
```

Returned tools:

- `tools.result(value)` / top-level `result`: structured return value. NumPy
  arrays, pandas objects, and torch tensors are summarized by shape/dtype/head.
- `tools.artifact(path)`: add a path to the returned artifacts.
- `tools.savefig(name, dpi=150)`: save the current matplotlib figure under the
  run's artifacts directory.
- `tools.exp_record(**kwargs)`: queue an experiment record; the plugin applies it
  after the process exits, even if the fragment later fails.

Limits: wall 600s, CPU 60s, memory 2GB (best-effort; `RLIMIT_AS` is not
enforceable on macOS), output cap 64KB per stream. Full files and the result JSON
are under `os.tmpdir()/opencode-deepseek-research/runs/<session>/<call>/`.
Network is blocked by default through an advisory Python socket guard; pass
`network: true` to allow it. This is not a security sandbox.

## Verification and final-answer gate

`verify` takes the exact answer plus structured `claims`:

| Claim | Check |
|---|---|
| `number` | Recompute a value from JSON/JSONL/CSV (`source` + `path`) or `experiment:<id>`; optional tolerance and unit |
| `citation` | Local path exists; URL/DOI/arXiv is fetched with HEAD (GET fallback); 404/410 fail |
| `file` | Path exists and is non-empty |
| `experiment` | Completed runs, distinct seeds, sample std, optional CI and max CI width, optional baseline fairness |
| `code` | Python compile, `bash -n`, `node --check`, or JSON parse (syntax only) |

The result is `{ pass, gate, issues, evidence, checks }` plus experiment
statistics. `pass: false` means rewrite before delivery. Supplying `answer` also
scans it: numeric tokens must match a claim/source, citations must be covered by
a citation claim, and `strict: true` promotes warnings to errors.

When `verifyGate` is enabled (default), the plugin listens for
`session.execution.succeeded`. If a completed **root-session** answer contains
verifiable numbers or citations and no receipt with the same answer hash and
`pass: true` exists, it injects one `<verify-gate state="blocked">` synthetic
message. Child/subagent sessions are ignored. A new user prompt invalidates the
previous receipt and resets the attempt counter. `verifyMaxGates` defaults to 1
per user prompt; `verifyGate: false` disables the gate, and
`verifyNetwork: false` only checks citation syntax/paths. Receipts live in plugin
KV under `verify:<projectID>:<sessionID>`.

## Best-of-N

`best_of_n` is intentionally expensive. Use it only for high-value tasks such as
research-gap exploration or brainstorming.

| Input | Meaning |
|---|---|
| `task` | Task sent unchanged to every candidate |
| `n` | 3–5 independent candidates (default 3) |
| `agent` / `judgeAgent` | Optional subagent ids; default inherits the parent agent |
| `judge` | Run a separate judge session (default true) |
| `rubric` | Up to 8 criteria, highest priority first |
| `timeoutSec` | Per-candidate wall limit (default 600s) |
| `maxAnswerChars` | Cap on the returned best answer (default 20k) |
| `background` | Return immediately with a `runID` instead of waiting |

Each candidate gets a new child session with its own context and tools. The judge
receives the task, rubric, candidate answers, and each candidate's `verify`
receipt status; it returns only ranks and disagreements. If the judge is disabled,
times out, or returns invalid JSON, the tool falls back to a candidate with a
passing `verify` receipt, then to the first completed candidate.

The tool is root-only. Without `background: true` it blocks the parent tool call.
With `background: true` it returns a `runID`; use `best_of_n_status` to poll
progress/result and `best_of_n_cancel` to interrupt candidate/judge sessions. A
finished run posts a synthetic `<best-of-n ...>` message to the parent session
when `bestOfNNotify` is true. Background runs are in-process: a server restart
marks them `interrupted`; they do not resume. Status is stored under
`bestofn-bg:<projectID>:<runID>`; the full result is also saved under
`bestofn:<projectID>:<runID>`.

## Cost panel and budget guard

`cost_report` returns a persisted usage table without changing research state:

| Input | Meaning |
|---|---|
| `groupBy` | `task` (root session + children, default), `session`, `agent`, or `model` |
| `sessionID` | Limit to one task; when omitted, the tool uses the current session's task |
| `format` | `markdown` (default) or `json` |

The report contains provider-reported USD, token totals, steps, failed steps,
sessions, unattributed cost, unpriced steps, and budget status. Costs are recorded
from `session.step.started` / `session.step.ended` and reconciled with
`session.usage.updated`; title and compaction usage are kept as `aux:title` /
`aux:compaction`. Records are stored under `cost:<projectID>:<sessionID>`.

Optional guard:

| Option | Meaning |
|---|---|
| `budgetUSD` | Project/task/session USD limit; `0` or omitted disables |
| `budgetScope` | `project` (default), `task` (root session subtree), or `session` |
| `budgetNotify` | Post a synthetic budget notice (default true) |

When the limit is reached, the plugin lets the current step finish, posts a
notice, and blocks tools except `cost_report`. On a subsequent model request it
cannot reject from a session hook, so it routes the request to a plugin-local
endpoint that returns HTTP 402 `budget_exceeded`; no provider request or
additional model cost occurs. The guard stops at the next request boundary, not
mid-stream.

This is local accounting, not cloud billing. USD is the provider-reported cost for
this OpenCode project; multiple servers do not share a lock. The synthetic notice
may be queued until the session next drains.

## Research presets, skills, and commands

| Agent | Role | Default effort / output |
|---|---|---|
| `scout` | Literature search and citation-backed evidence tables | low / 8k |
| `experimenter` | Preregistration, experiment plans, seeds and artifacts | high / 16k |
| `analyst` | Statistics, uncertainty, baseline fairness, causal caution | high / 16k |
| `critic` | Red-team review; calls `verify` before accepting claims | max / 16k |
| `writer` | Papers, reports, LaTeX tables, rebuttals | low / 32k |

Presets use `mode: "all"`, so they can be selected directly or used as
`best_of_n` candidates. If an agent with the same id already exists, the plugin
does not overwrite it. Set `agentPresets: false` to skip registration.

Five embedded skills are registered with auto-invoke enabled:

- `deepseek-paper-reading`
- `deepseek-experiment-design`
- `deepseek-statistics`
- `deepseek-latex`
- `deepseek-rebuttal`

Set `researchSkills: false` to skip them. Skills are embedded in the plugin and do
not require project files.

| Command | Agent | Purpose |
|---|---|---|
| `/lit` | `scout` | Literature review and evidence table |
| `/prereg` | `experimenter` | Preregistered experiment plan |
| `/ablate` | `experimenter` | Prioritized ablation matrix |
| `/verify` | `critic` | Claim audit with the `verify` tool |
| `/paper` | `writer` | Paper/report section from verified evidence |

Commands switch the current session to the mapped agent when it exists, then send
a structured prompt with your text appended. If the agent is unavailable or the
switch fails, the command still runs under the current agent. Set
`researchCommands: false` to skip them.

## Removed by scope

The following features were implemented earlier but removed from this profile
because experiments run on a Linux server outside OpenCode:

- `job_start` / `job_status` / `job_logs` / `job_cancel` / `job_list`
- local detached job runner and completion notifications
- SLURM provider (local and SSH)
- automatic shell-experiment recording
- GPU-hour accounting and GPU budget monitor

The plugin now exposes **10 plugin tools** (22 tools advertised including
OpenCode built-ins): `cost_report`, four `exp_*` tools, `verify`, `best_of_n`,
`best_of_n_status`, `best_of_n_cancel`, and `run_code`.

## Needed but not developed

| Feature | Why it is still relevant | Status |
|---|---|---|
| Installation/global config | Make the plugin load in daily OpenCode instead of only temp projects | Deferred until development ends |
| Zero-model `/cost` command | Show the cost panel without spending a model turn | Optional |
| Official DeepSeek Messages validation | Verify the native Anthropic-compatible route if you switch from OpenCode Go | Blocked: no credentials |

K8s, generic SSH jobs, real SLURM validation, multi-server locks, GPU allocation,
and cloud billing are **not needed** for this profile.

## Test

```sh
bun install
bun test
bun run typecheck
```

Verified in a temporary copy with the real `@opencode/plugin@2.1.3` package:

- `bun test`: **102 pass, 0 fail**, 386 assertions.
- `tsc --noEmit`: clean.
- `bun build index.ts --target=node`: success (14 modules, 176.49 KB).
- OpenCode 2.1.3 smoke tests from earlier rounds cover research rules, verify
  gate, Best-of-N, presets/commands, cost reporting, and real OpenCode Go DeepSeek
  cost/budget behavior. Job/SLURM smoke tests were removed with those features.
- The current profile still advertises research rules in the system prompt,
  per-agent effort/output budgets, the experiment registry, `run_code`, `verify`,
  `best_of_n`, presets/skills/commands, and `cost_report`.

## Provider

See `examples/opencode.deepseek.jsonc` for the DeepSeek Messages provider
configuration. The plugin also works with the OpenAI-compatible route, including
OpenCode Go's `opencode-go/deepseek-v4.1-flash`. Official DeepSeek Messages
validation remains pending.

## Scope and caveats

- This is the Round 14 build after scope reduction: research rules, effort
  routing, output budgets, cache audit, research compaction, tool-result spill,
  experiment registry, fresh/persistent Python analysis, deterministic
  verification, final-answer gate, synchronous/background Best-of-N,
  presets/skills/commands, USD cost panel, and USD budget guard.
- `run_code` defaults to a fresh process; `runCodeKernel: "persistent"` opts into
  per-session state. Persistent mode caps memory at kernel start, enforces the
  wall timeout by killing the kernel, and does not enforce per-call `cpuSec`.
- Network blocking is advisory Python-level patching, not OS sandboxing. Memory
  limits are best-effort on macOS.
- `verify` checks code syntax, not full execution; use `run_code` for runtime
  checks.
- The final-answer gate catches numbers and citations, not every qualitative
  claim, and stops after `verifyMaxGates` attempts per user prompt.
- `best_of_n` costs N candidate runs plus an optional judge. It is synchronous
  unless `background: true`; background runs are in-process and are marked
  interrupted on server restart. Judge quality depends on the configured model;
  candidates are not diversified across models by default.
- Agent presets and commands are prompt-level guidance, not deterministic
  workflows. Existing agents/skills with the same ids are not overwritten.
- Cost accounting is local to the project KV; it is not cloud billing.
- Experiments, long runs, GPU allocation, and scheduler management are intentionally
  outside this plugin; use your Linux server for those.

# Progress Log

## Round 1 — 2026-10-23

### Scope

P0 foundation:

- research-mode system block;
- per-agent reasoning effort routing;
- per-agent output-token budgets;
- compaction effort/budget override;
- DeepSeek Messages provider example.

### Files

- `plugin/policy.ts` — pure policy functions and research rules.
- `plugin/index.ts` — `deepseek.research` plugin.
- `test/policy.test.ts` — unit tests for policy.
- `test/plugin.test.ts` — hook registration and behavior tests.
- `test/config.test.ts` — JSONC example validation.
- `examples/opencode.deepseek.jsonc` — provider + compaction example.

### Decisions

- Keep round 1 plugin-only; no OpenCode core changes.
- Do not auto-apply the provider example to the user's global config.
- Keep the OpenAI-compatible route as fallback until Messages is verified.
- Do not add cache metering yet; defer to round 2 after usage events are inspected.

### Test plan

- `bun test` for policy, plugin, and config.
- `bun build plugin/index.ts --target=node` for syntax/bundle check.
- Typecheck deferred: the shell sandbox cannot write to the workspace, so
  `bun install` fails with `PermissionDenied`; a local identity shim for
  `@opencode/plugin` is used only for tests.

### Results — 2026-10-23

- `bun test`: **17 pass, 0 fail**, 3 files, 33 assertions.
- `bun build plugin/index.ts --target=node`: **success**, 3 modules bundled.
- Git: initialized with a separate git dir under the approved temp path;
  first commit `7b69b9e` — "round 1: research rules, effort routing, output
  budgets, provider example".
- Worktree remains `/Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research`.

### Known limitations

- `@opencode/plugin` is not installed from npm in this environment; tests use a
  tiny identity shim at `node_modules/@opencode/plugin` (ignored by Git).
  Run `bun install` in a normal shell before typechecking or packaging.
- The provider example is **not** applied to the live global config; it is a
  project-local template.
- No integration test against a running OpenCode instance yet.

### Next

- Add cache/usage audit via `ctx.event.subscribe`.
- Replace default compaction summary with a research checkpoint through
  `session.hook("compaction")`.
- Add tool-result pruning/spill via `execute.after`.
- Run a real `bun install` + `tsc --noEmit` in an unrestricted shell.

## Round 2 — 2026-10-23

### Scope

P0-4 and P1-1/P1-2:

- cumulative prompt-cache audit from `session.usage.updated`;
- research-specific compaction instructions;
- string tool-result spill above 32K characters.

### Files

- `plugin/policy.ts` — cache stats, warning policy, compaction rules, prune
  helpers, spill path helper, cache auditor, tool-result pruner.
- `plugin/index.ts` — event subscription, storage persistence, compaction hook,
  `execute.after` hook, private spill files (`0600`).
- `test/policy.test.ts` — cache, compaction, and prune unit tests.
- `test/plugin.test.ts` — hook wiring, usage-event persistence, compaction
  rules, small-result pass-through.
- `README.md` — round 2 behavior and caveats.

### Decisions

- Use cumulative `session.usage.updated` stats; per-step accounting is not
  needed for a hit-rate audit.
- Hit rate = `cache.read / (input + cache.read + cache.write)`; warn only after
  200K prompt tokens and below 50%, once per session.
- Keep compaction as a model-generated summary, but add a strict section
  contract; do not replace it with a deterministic stub.
- Spill only `content: string` results. Array-shaped results are deferred until
  their part semantics are verified.
- Spill under `os.tmpdir()/opencode-deepseek-research/<session>/<call>.txt`;
  directory `0700`, file `0600`.
- Persist cache stats under `deepseek-research:cache:<sessionID>` via
  `ctx.storage`.

### Test plan

- `bun test` for pure policy and plugin wiring.
- `bun build plugin/index.ts --target=node` for syntax/bundle check.
- Attempted CLI smoke test with a temp project config; blocked by
  `EPERM` on `~/.local/state/opencode/locks` in the shell sandbox.

### Results — 2026-10-23

- `bun test`: **32 pass, 0 fail**, 3 files, 87 assertions.
- `bun build plugin/index.ts --target=node`: **success**, 3 modules bundled.
- Git commit `f518cfb` — "round 2: cache audit, research compaction,
  tool-result spill"; follow-up `18ce81c` — "round 2 fix: tighten
  tool-result pruning guard".

### Known limitations

- `bun install` / `tsc --noEmit` still cannot run in this shell; typecheck
  remains unverified against the real `@opencode/plugin` types.
- Array-shaped tool results are not pruned. (Fixed in Round 3.)
- Cache warning thresholds are fixed constants, not plugin options yet.
- CLI smoke test blocked by sandbox permissions; no live OpenCode integration
  test yet.

### Next

- Round 3: experiment registry (`exp`) and structured artifact paths.
- Add plugin options for cache thresholds and tool-result limit.
- Verify `execute.after` mutation and storage behavior in a real OpenCode
  session once the shell can run the CLI with a writable state dir.
- Run `bun install && bun run typecheck` in an unrestricted shell.

## Round 3 — 2026-10-23

### Scope

P1-3 plus follow-ups discovered during integration:

- experiment registry (`exp_record`, `exp_query`, `exp_compare`, `exp_best`);
- project-scoped KV persistence with structured artifact paths;
- automatic shell-run recording;
- tool-result spill for text-part arrays (shell output), not just strings;
- plugin options for cache thresholds, spill limit, and auto-record.

### Files

- `index.ts` — package entrypoint re-exporting `plugin/index.ts`.
- `plugin/experiments.ts` — registry types, KV store, query/compare/best,
  tool schemas, auto-record, result notes.
- `plugin/index.ts` — registers four direct `exp_*` tools, auto-record hook,
  option parsing, array-capable spill.
- `plugin/policy.ts` — configurable cache thresholds; array tool-result pruning.
- `test/experiments.test.ts` — registry, comparison, tool wiring, auto-record.
- `test/plugin.test.ts` — root entry, four tools, hooks, cache persistence.
- `test/policy.test.ts` — custom cache thresholds, array spill.
- `README.md`, `GUIDE.md`, `PROGRESS.md`, `package.json`, `tsconfig.json`.

### Decisions

- Use `ctx.storage` KV records instead of a new SQLite table. Keys are
  `exp:<projectID>:<experimentID>`; `scan` provides per-project listing without
  a core migration. The GUIDE SQL schema maps to the record fields.
- Register `exp_*` with `options: { codemode: false }` so they are advertised
  directly to the model rather than hidden behind the `execute` code-mode tool.
- Add a root `index.ts` entrypoint. OpenCode's packaged resolver did not resolve
  the package `exports`/`main` for a local directory; a root `index.ts` fallback
  made the plugin load.
- Auto-record only recognizable research commands: `python … .py`,
  `torchrun`, `accelerate launch`, `deepspeed`, `sbatch`. `sbatch` and
  background shells are `running`; errors, timeouts, signals, and nonzero exits
  are `failed`.
- Prune array-shaped tool results by joining text parts, spilling once, and
  preserving file parts. This covers the shell tool, which returns text parts.
- Keep the research rules and cache audit behavior from Round 2; thresholds are
  now plugin options.

### Test plan

- `bun test` and `bun build` in the workspace.
- Copy to a temp directory, install the real `@opencode/plugin@2.1.3`, run
  `bun test` and `tsc --noEmit`.
- Start OpenCode 2.1.3 with a temp HOME and a local fake OpenAI-compatible
  provider; create a session, send a prompt, inspect `/api/plugin`, the model
  request body, and the plugin KV database.
- Make the fake model call `exp_record`; verify the tool result and SQLite KV
  record.

### Results — 2026-10-23

- Workspace `bun test`: **52 pass, 0 fail**, 4 files, 163 assertions.
- Workspace `bun build index.ts --target=node`: **success**, 5 modules.
- Temp copy with real `@opencode/plugin@2.1.3`:
  - `bun test`: **52 pass, 0 fail**;
  - `tsc --noEmit`: **clean**.
- OpenCode 2.1.3 smoke test:
  - plugin inventory: `deepseek.research`, state `active`;
  - model request tools: 16 total, including `exp_record`, `exp_query`,
    `exp_compare`, `exp_best`;
  - system prompt contains `科研模式`; `max_completion_tokens: 16000`;
    `reasoning_effort: high`;
  - `exp_record` call returned the normalized experiment and wrote a KV record
    under `exp:<projectID>:exp-...`;
  - cache audit wrote `deepseek-research:cache:<sessionID>`.
- Git commit `74e1e17` — "round 3: experiment registry, direct exp tools,
  auto-record, array spill"; follow-ups `0530a39` (hook-level test coverage)
  and `b0476ec` (generated-id validation, spill-limit floor).

### Known limitations

- Local workspace tests still use the tiny `@opencode/plugin` shim; the temp
  copy with the real package is the authoritative test.
- Auto-record misses `python -m …`, arbitrary `bash train.sh`, and commands
  that hide a launcher in a script.
- Array results are flattened to one preview text part plus original file parts;
  part boundaries are not preserved.
- The registry is KV-backed, not a custom SQL table; queries scan the current
  project prefix.
- No live DeepSeek request was made in the smoke test; the provider was a local
  fake. Real DeepSeek Messages validation is still pending.

### Next

- Round 4: P2 Python `run_code` and/or background `job` runtime.
- Add a `metrics` ingestion path from logs/JSON into `exp_record`.
- Validate the plugin against a real DeepSeek Messages session.
- Consider an explicit compaction `result.summary` checkpoint if model-generated
  summaries miss required sections.

## Round 4 — 2026-10-23

### Scope

P2-1 and P2-2, local versions:

- `run_code` fresh CPython process with `tools.result` / `tools.artifact` /
  `tools.savefig` / `tools.exp_record`;
- detached local jobs: `job_start`, `job_status`, `job_logs`, `job_cancel`,
  `job_list`;
- job metadata in plugin KV, logs/status on disk, queryable after plugin
  manager restart;
- optional linked experiment and `metricsPath` JSON ingestion;
- plugin options for Python path and runtime budgets;
- tests, docs, real OpenCode smoke test.

### Files

- `plugin/runtime.ts` — Python runner, output/value previews, experiment bridge.
- `plugin/jobs.ts` — job record schema, detached runner, status reconciliation,
  logs, cancel, metrics ingestion, five tools.
- `plugin/index.ts` — runtime/job options and registration; tool transform now
  registers 10 plugin tools.
- `test/runtime.test.ts` — value/stdout, scientific plot + experiment, errors,
  timeout, output cap, network guard, tool registration.
- `test/jobs.test.ts` — completion, manager restart, failure, cancel, log tail,
  timeout, metrics JSON, tool registration.
- `README.md`, `GUIDE.md`, `PROGRESS.md`, `examples/opencode.deepseek.jsonc`,
  `test/config.test.ts`.

### Decisions

- Keep `run_code` as a fresh process rather than a persistent kernel. It is
  simpler, isolates crashes, and matches the current acceptance target; the
  cost is repeated imports.
- Expose a small Python `tools` bridge instead of a full RPC to every OpenCode
  tool. `exp_record` calls are queued in JSONL and applied after the subprocess
  exits, so a later Python failure still preserves completed records.
- Use a detached Python job runner. It survives OpenCode restarts, writes
  status atomically, and starts the actual command in its own session so
  cancellation can kill the whole process group.
- Store job metadata in `ctx.storage` (`job:<projectID>:<jobID>`), not a new
  SQLite table. Logs and status files are per-job under
  `os.tmpdir()/opencode-deepseek-research/jobs/`.
- `metricsPath` is opt-in. The runner remains generic; the plugin reads a JSON
  object of numeric metrics on terminal status and merges it into the linked
  experiment.
- Network blocking is an advisory Python socket guard, not a sandbox. Memory
  limits are best-effort; macOS may reject `RLIMIT_AS`.
- Local jobs are the only provider in this round. No SLURM/SSH/K8s adapter and
  no push completion event yet.

### Test plan

- `bun test` and `bun build` in the workspace.
- Temp copy with real `@opencode/plugin@2.1.3`: `bun test` and
  `tsc --noEmit`.
- Real OpenCode 2.1.3 with a fake provider: verify 22 advertised tools and
  execute `run_code`, `job_start`, `job_status`, `job_logs`.
- Inspect request body, tool results, job log, and linked experiment KV record.

### Results — 2026-10-23

- Workspace `bun test`: **66 pass, 0 fail**, 6 files, 228 assertions.
- Workspace `bun build index.ts --target=node`: **success**, 7 modules.
- Temp copy with real `@opencode/plugin@2.1.3`:
  - `bun test`: **66 pass, 0 fail**;
  - `tsc --noEmit`: **clean**.
- OpenCode 2.1.3 smoke test:
  - plugin inventory `deepseek.research`, state `active`;
  - 22 tools advertised, including `run_code`, five `job_*`, and four `exp_*`;
  - `run_code` executed a Python fragment and returned `{two: 2, sum: 45}`
    with bounded stdout and full-file paths;
  - `job_start` started a detached job; `job_status` returned `completed`;
    `job_logs` returned `job hello`;
  - the linked experiment was created with status `completed` and the job log
    path.
- Restart smoke test:
  - started a 20s job under server A, killed server A, started server B with
    the same temp HOME/project;
  - `job_status` on server B returned `running` with the original runner and
    child PIDs;
  - `job_cancel` on server B returned `cancelled`, wrote the status file, and
    marked the linked experiment `aborted`.
- Git commit `b852aa2` — "round 4: python run_code, detached jobs,
  metrics ingestion".

### Known limitations

- Local jobs only: no SLURM/SSH/K8s, no GPU allocation, no push completion
  notification.
- `run_code` is not a security sandbox; network blocking is advisory and the
  workspace is not confined.
- Memory limit is not enforceable on macOS; CPU/wall limits and output caps are.
- No persistent kernel; scientific imports are paid each call.
- Verify and best-of-N are not implemented.
- Real DeepSeek Messages validation is still pending.

### Next

- Round 5: P2-3 `verify` / P2-4 best-of-N, or a scheduler adapter.
- Add completion notifications through the session API.
- Optionally add a persistent Python kernel for repeated analysis.
- Validate against a real DeepSeek Messages session.

## Round 5 — 2026-10-23

### Scope

Finish the missing P2-2 requirement: push a completion event when a detached
job reaches a terminal state.

- persist the starting `sessionID` in the job record;
- poll pending terminal jobs in the plugin process;
- inject a synthetic `<job ...>` message through `ctx.session.synthetic`;
- persist `notifiedAt` / `notificationAttempts` for deduplication and retry;
- add opt-outs (`notify: false`, `jobNotifications: false`);
- test unit behavior and real OpenCode wake-up.

### Files

- `plugin/notifications.ts` — notifier loop, bounded message formatting, retry
  and deduplication.
- `plugin/jobs.ts` — `sessionID`, `notify`, `notifiedAt`,
  `notificationAttempts`, `notificationError`; `pendingNotifications` and
  `markNotification`; `job_start` accepts tool context.
- `plugin/index.ts` — notifier lifecycle (`start`/`stop`), options.
- `test/notifications.test.ts` — one-shot delivery, retry/give-up, `notify:
  false`, formatting.
- `test/jobs.test.ts` — job start now records `notify`/`sessionID` through the
  tool context where supplied.
- `README.md`, `GUIDE.md`, `PROGRESS.md`, `examples/opencode.deepseek.jsonc`,
  `test/config.test.ts`.

### Decisions

- Use `ctx.session.synthetic` rather than a separate webhook or core change.
  OpenCode's built-in background shell uses the same mechanism.
- Use `delivery: "queue"` and `resume: true`: an idle session wakes up, while
  an active turn is not interrupted. This can consume model tokens; users can
  disable notifications.
- Poll every 5 seconds by default with `setInterval(...).unref()`, so the timer
  does not keep the process alive. The interval starts only when the session
  domain exposes `synthetic` (not in the unit-test mock).
- Store notification state in the job KV record. `notifiedAt` prevents repeats;
  `notificationAttempts` caps failures at three. A missing `sessionID` is
  marked notified with an error instead of retrying forever.
- Notification text includes job id, state, exit code, command, experiment id,
  log path, and a 2KB tail. Full logs remain available through `job_logs`.

### Results — 2026-10-23

- Workspace `bun test`: **70 pass, 0 fail**, 7 files, 262 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` **clean**.
- OpenCode 2.1.3 push smoke:
  - `job_start` launched a 1s job and returned `running`;
  - after the job completed, the notifier injected a synthetic message:
    `<job id="job-..." state="completed" exitCode="0">` with command,
    experiment, log path, and tail;
  - the fake provider received a third `/chat/completions` request containing
    the notification and answered `notification received`;
  - the session context shows the synthetic message followed by the assistant
    response, with no polling call.
- Unit tests cover one-shot delivery, duplicate suppression across notifier
  instances, retry after a synthetic failure, give-up after three attempts, and
  `notify: false`.
- Git commit `c0bacae` — "round 5: push job completion into starting session".

### Known limitations

- Notifications are at-least-once across multiple OpenCode servers sharing one
  project; a single server deduplicates through `notifiedAt`.
- The notification wakes the session and may incur model cost.
- Jobs started before this round have no `sessionID`; they are marked with a
  notification error instead of being delivered.
- Local jobs only: no SLURM/SSH/K8s.

### Next

- Round 6: P2-3 `verify` — recompute numbers, check citations/paths, seed
  variance, baseline fairness, and code runnability; then gate final answers.
- Then P2-4 best-of-N.
- Validate against a real DeepSeek Messages session.

## Round 6 — 2026-10-23

### Scope

Implement P2-3 as a deterministic `verify` tool plus a controlled final-answer
gate. No extra model/subagent call is required for the checks.

### Files

- `plugin/verify.ts` — structured claims, numeric/citation/file/experiment/code
  checks, answer scan, receipts.
- `plugin/gate.ts` — `session.execution.succeeded` gate, exact-answer receipt
  matching, synthetic rewrite message.
- `plugin/index.ts` — `verify` registration, gate lifecycle, prompt reset,
  options.
- `plugin/policy.ts` — research rule 6: call `verify` before the final answer.
- `test/verify.test.ts` — number formats, units, citations, experiments,
  code, receipts.
- `test/gate.test.ts` — one-shot gate, passing/failing receipts, tool-call
  messages, claim-free answers, deprecated idle events.
- `test/plugin.test.ts`, `test/config.test.ts`,
  `examples/opencode.deepseek.jsonc`, `README.md`, `GUIDE.md`, `PROGRESS.md`.

### Decisions

- Verification is claim-driven instead of an LLM critic: every number has a
  source/path, citations have URLs/paths, and experiments have ids/metrics.
  This is cheaper and reproducible.
- `verify` supports JSON/JSONL/CSV and `experiment:<id>` numeric sources;
  units are checked only when the source records one. CSV parsing is a small
  local parser, not a new dependency.
- Citations use HEAD with a GET `Range` fallback and a 5s timeout. 404/410 are
  errors; network/gated/5xx responses are warnings unless `strict`.
- Code checks are syntax-only (`compile`, `bash -n`, `node --check`, JSON parse).
  Full execution belongs to `run_code` / `job_*`.
- The gate listens to `session.execution.succeeded`, not just
  `session.status`/`session.idle`: the real 2.1.3 build emitted execution events
  but no status event, and session context ends with an `idle` marker message.
- A passing receipt is bound to the exact normalized answer hash. Changing the
  answer requires another verify call. Default `maxGates = 1` per user prompt;
  the prompt hook resets the counter and invalidates the previous receipt so a
  later turn cannot reuse it.
- Answer scanning ignores dates and conventional `p < 0.05` / `95% CI` labels
  to reduce false positives. Other numeric tokens must match a claim/source.
- Receipts are stored under `verify:<projectID>:<sessionID>`; gate attempts are
  in memory. Multiple servers can gate once each, but receipt dedupe is shared.

### Results — 2026-10-23

- Workspace `bun test`: **88 pass, 0 fail**, 9 files, 336 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` **clean**;
  `bun build index.ts --target=node` **success**.
- OpenCode 2.1.3 gate smoke:
  - first final answer: `Accuracy reached 73.4% on the held-out set.`;
  - gate injected one `<verify-gate state="blocked" ...>` synthetic message;
  - fake provider called `verify` with the answer and a number claim;
  - verify read `metrics.json` (`accuracy: 73.42`, tolerance `0.05`), returned
    `pass: true`, `gate: "ok"`, `receiptSaved: true`;
  - model returned the same answer; the next `session.execution.succeeded` saw
    the matching passing receipt and did not gate again;
  - context contains exactly one gate message and one verify tool call; the
    provider received 3 requests.
- Unit tests cover failing receipts, changed-answer mismatch, retries not
  applicable, tool-call intermediate messages, claim-free answers,
  `verifyGate: false`, and both execution/idle event forms.
- Git commit `c3d641f` — "round 6: deterministic verify and final-answer gate".

### Known limitations

- Qualitative claims are not verified; only numeric, citation, file,
  experiment, and code claims.
- Code checks are syntax-only; imports, runtime errors, and data availability
  require `run_code` or a job.
- The gate matches the exact answer text (normalized line endings and trim).
  A paraphrased final answer is gated again.
- URL citation checks depend on network reachability; warnings are not hard
  failures unless `strict: true`.
- Gate attempts are per server process; multiple servers sharing a project can
  each send one reminder.
- No live DeepSeek Messages validation yet.

### Next

- Round 7: P2-4 best-of-N, or a scheduler adapter.
- Optionally add a persistent Python kernel and multi-server gate/notification
  locking.
- Validate against a real DeepSeek Messages session.

## Round 7 — 2026-10-23

### Scope

Implement P2-4 Best-of-N as a local orchestration tool: 3–5 independent child
sessions, optional judge, rubric ranking, fallback, and cost controls.

### Files

- `plugin/bestofn.ts` — `best_of_n` tool, parallel child sessions, candidate
  extraction, judge prompt/parser, verified fallback, run records.
- `plugin/messages.ts` — shared final-assistant-text extraction.
- `plugin/gate.ts` — root-session-only gate; child/candidate/judge sessions are
  intermediate and are ignored.
- `plugin/index.ts` — `best_of_n` registration, options, gate wiring.
- `plugin/policy.ts` — rule 7: use Best-of-N only for high-value, verifiable
  tasks.
- `test/bestofn.test.ts` — 8 orchestration tests.
- `test/gate.test.ts` — child-session gate test.
- `test/plugin.test.ts`, `test/policy.test.ts`, `test/config.test.ts`,
  `examples/opencode.deepseek.jsonc`, `README.md`, `GUIDE.md`, `PROGRESS.md`.

### Decisions

- Use `ctx.session.create({parentID})`, `prompt`, `wait`, and `context`
  directly instead of trying to call the built-in `subagent` tool from plugin
  code. Each candidate gets a genuinely independent child context.
- Candidates inherit the parent agent/model when available; `agent` and
  `judgeAgent` can override. If the inherited agent/model is rejected, child
  creation retries with project defaults.
- The judge is a separate child session. It receives the task, rubric,
  candidate answers, and each candidate's `verify` receipt status; it returns
  only candidate numbers, ranks, and disagreements (no scores).
- If the judge is disabled, times out, or returns invalid JSON, fallback is:
  candidate with a matching passing `verify` receipt, then first completed
  candidate. This keeps the tool useful without a reliable judge.
- Best-of-N is root-only. A child session calling `best_of_n` is rejected to
  prevent recursive cost explosions.
- Gate is now root-only. Candidate/judge sessions have `parentID` and are
  skipped, avoiding extra verify turns during parallel runs.
- Cost controls: `n=3..5`, `bestOfNMaxCandidates <= 5`, per-candidate timeout,
  optional judge, judge timeout. There is still no USD/GPU budget guard.
- Candidate answers are capped to 20k chars in the returned best answer and
  12k chars each in the judge prompt; full records are stored under
  `bestofn:<projectID>:<runID>`.

### Results — 2026-10-23

- Workspace `bun test`: **97 pass, 0 fail**, 10 files, 379 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` **clean**;
  `bun build index.ts --target=node` **success**.
- OpenCode 2.1.3 Best-of-N smoke:
  - parent called `best_of_n` with `{task, n: 3, judge: true}`;
  - three candidate child sessions returned 71.0%, 73.4%, 72.1%;
  - judge child returned `best: 2`, ranking, and a disagreement;
  - tool result had `basis: "judge"`, `best.index: 2`, `best.answer`
    containing `73.4%`, and all three candidates `completed`;
  - provider received 6 requests total: main tool call, 3 candidates, judge,
    and main final answer;
  - no child-session verify gate appeared in the run.
- First smoke attempt exposed a harness bug: the fake provider matched
  "independent candidate" inside the `best_of_n` tool description. The stub
  was changed to inspect the last user message instead; the plugin behavior was
  unchanged.
- Unit tests cover judge selection, judge-disabled verified fallback, candidate
  failure, invalid judge JSON fallback, all-candidates-failed, missing context,
  and nested-call rejection.
- Gate unit test confirms a child session with `parentID` is ignored while the
  root session is still gated.
- Tool count: **24** advertised (12 plugin tools).
- Git commit `697f110` — "round 7: parallel best-of-n with judge and verified fallback".

### Known limitations

- Best-of-N is synchronous: the parent tool call blocks until all candidates
  and the judge finish (or time out). It has no background/job integration yet.
- Candidate diversity is prompt/session isolation, not multi-model or
  multi-temperature sampling. All candidates inherit the same configured model
  by default.
- The judge is the same model family by default; judge quality is not
  independently validated. Invalid judge output falls back deterministically.
- No USD/GPU-hour budget guard; only candidate count and timeouts.
- Full run records are KV-backed and may be large; answers are truncated in
  returned/context fields.
- No cross-server locking for runs or gate attempts.
- No live DeepSeek Messages validation yet.

### Next

- Round 8 options: scheduler adapter (SLURM/SSH/K8s), persistent Python kernel,
  or P3 presets/commands/cost dashboard.
- Add a real budget guard and background Best-of-N if cost data is available.
- Validate against a real DeepSeek Messages session.

## Round 8 — 2026-10-23

### Scope

Implement the P3 preset layer: five research agents, five embedded skills, and
five slash commands. Keep the cost panel and budget guard for a later round.

### Files

- `plugin/presets.ts` — agent/skill/command definitions and registration.
- `plugin/index.ts` — guarded preset registration and options.
- `test/presets.test.ts` — agent/skill/command registration and execution tests.
- `test/plugin.test.ts` — mock agent/skill/command domains and registration assertions.
- `test/config.test.ts`, `examples/opencode.deepseek.jsonc`, `README.md`,
  `GUIDE.md`, `PROGRESS.md`.

### Decisions

- Use `ctx.agent.transform` and `editor.update` for presets. `update` creates a
  default agent when the id is missing; skip when `editor.get(id)` already
  exists so user-defined agents are not overwritten.
- Presets use `mode: "all"` so they can be selected in the current session and
  used as `best_of_n` candidates.
- Use `ctx.skill.transform` for five embedded skills. The content lives in the
  plugin; no project skill files are required. `autoinvoke: true` makes them
  discoverable through the skill tool.
- Use `ctx.command.transform` for `/lit`, `/prereg`, `/ablate`, `/verify`, and
  `/paper`. Each command prepends a structured research template, optionally
  switches to the mapped preset agent, then sends the combined prompt.
- If the mapped agent is unavailable or `switchAgent` fails, the command still
  prompts under the current agent and warns. This keeps commands usable when
  presets are disabled or shadowed by user config.
- Existing agents/skills with the same ids are never overwritten. Config-defined
  agents can still replace or customize presets.
- Options: `agentPresets`, `researchSkills`, `researchCommands` default true.

### Results — 2026-10-23

- Workspace `bun test`: **103 pass, 0 fail**, 11 files, 406 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` **clean**;
  `bun build index.ts --target=node` **success**.
- OpenCode 2.1.3 presets smoke:
  - after the first prompt activated the plugin, `/api/agent` listed `scout`,
    `experimenter`, `analyst`, `critic`, and `writer`;
  - `/api/skill` listed all five embedded `deepseek-*` skills;
  - `/api/command` listed `/lit`, `/prereg`, `/ablate`, `/verify`, and `/paper`;
  - `/lit graph neural networks` produced an `agent-switched: scout` message;
  - the provider request contained the Scout system prompt, `max_completion_tokens:
    8000`, and `reasoning_effort: low`;
  - one provider request, no verify-gate turn.
- Direct `/api/agent` and `/api/skill` calls before the first prompt returned an
  empty list because plugin activation is lazy; after activation both lists were
  complete. This is expected OpenCode behavior, not a preset failure.
- Unit tests cover existing-id preservation, agent mode/system, skill paths and
  autoinvoke, command registration, agent switching, switch failure, empty input,
  missing agent lookup, and disabling all three preset groups via options.
- Git commit `d21ea65` — "round 8: research agents, skills, and slash commands".

### Known limitations

- Commands are prompt templates, not deterministic multi-step workflows.
- Presets are registered only when the id is absent; there is no merge policy
  for customizing an existing preset.
- The cost panel is still per-session cache stats only; no per-task/agent/model
  cost aggregation.
- No USD/GPU-hour budget guard.
- No live DeepSeek Messages validation yet.

### Next

- Round 9: cost panel and budget guard, or scheduler adapter.
- Validate against a real DeepSeek Messages session.
- Add background Best-of-N if cost data is available.

## Round 9 — 2026-10-23

### Scope

Implement P3 cost observability and local budget guards: per-task/session/agent/model
USD and token accounting, GPU hours from job records, a read-only `cost_report`
tool, and USD/GPU-hour limits with stopping behavior.

### Files

- `plugin/cost.ts` — event aggregation, persisted records, reports, budget checks.
- `plugin/budget-server.ts` — local 402 endpoint for blocked model requests.
- `plugin/index.ts` — tracker lifecycle, usage/model/tool hooks, GPU job monitor.
- `test/cost.test.ts`, `test/budget-server.test.ts`, `test/plugin.test.ts`,
  `test/config.test.ts`.
- `examples/opencode.deepseek.jsonc`, `README.md`, `GUIDE.md`, `PROGRESS.md`.

### Decisions

- Use `session.step.started` to map `assistantMessageID` to agent/model, then
  aggregate `session.step.ended`/`failed` cost and tokens. Reconcile cumulative
  totals with `session.usage.updated`; keep title/compaction as `aux:*` buckets.
- Persist one record per session under `cost:<projectID>:<sessionID>`; task
  grouping walks `parentID` from `session.created`, so Best-of-N children roll
  into the root task.
- Count GPU hours only from job records with a `gpu` tag. Running jobs count to
  now; jobs without a `gpu` tag are ignored.
- `cost_report` supports `task`, `session`, `agent`, and `model`, and defaults
  to the calling session's task when no filter is supplied.
- Budget scopes are `project`, `task`, and `session`; `0`/omitted limits disable
  enforcement. The default scope is project.
- Session hooks cannot return a typed failure, so a blocked `model.request`
  changes `baseURL` to a local 402 endpoint. This prevents the provider call and
  additional model cost; the client surfaces `provider.quota` /
  `budget_exceeded`.
- `tool.execute.before` blocks all tools except `cost_report` and
  `job_status`/`job_logs`/`job_list`/`job_cancel` after a stop.
- A project-scoped GPU monitor cancels running jobs with a `gpu` tag when the
  GPU-hour limit is exceeded. Task/session GPU scopes do not start this global
  monitor.
- Budget callbacks do not block the event subscription loop. The synthetic
  notice is posted asynchronously.

### Results — 2026-10-23

- Workspace `bun test`: **113 pass, 0 fail**, 13 files, 456 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` **clean**;
  `bun build index.ts --target=node` **success** (15 modules, 188.98 KB).
- Cost-report smoke:
  - `cost_report` returned `Scope: task ...`, `$0.000420`, 1,100 tokens,
    1 step, and agent `build`;
  - the report was persisted and available from a later tool call.
- Budget smoke on a clean project:
  - first prompt made 1 provider request and cost `$0.000420`, exceeding the
    configured `$0.0001` project limit;
  - the next prompt made **0 additional provider requests** and failed with
    `provider.quota` / `budget_exceeded` from the local 402 endpoint;
  - a synthetic budget notice was present in the session.
- Tool count: **25** advertised (13 plugin tools).
- Unit tests cover task/child aggregation, agent/model grouping, auxiliary
  usage, USD and task-scoped limits, GPU hours, markdown/JSON reports, context
  defaults, the 402 endpoint, tool blocking, and `model.request` rewriting.
- Git commit `7385a6e` — "round 9: cost reporting and USD/GPU budget guards".

### Known limitations

- The synthetic budget notice can be queued until the session next drains or
  resumes; the 402 stop is the deterministic enforcement point.
- The guard stops after a usage boundary; a response already in flight can
  finish. It is not a mid-stream token killer.
- USD is provider-reported cost stored in local plugin KV, not cloud billing;
  multiple servers do not share a lock.
- GPU hours only include `job_start` records with a `gpu` tag. Task/session GPU
  scopes do not run the global job-cancelling monitor.
- No live DeepSeek Messages validation yet.
- No scheduler adapter or persistent Python kernel yet.

### Next

- Validate against a real DeepSeek Messages session.
- Choose a scheduler adapter (SLURM/SSH/K8s) or background Best-of-N.
- Add a user-facing zero-model-call cost panel command if needed.

## Round 10 — 2026-10-23

### Scope

Validate the plugin against the only available real DeepSeek access: the
OpenCode Go subscription model `opencode-go/deepseek-v4.1-flash`. Refine the
budget guard based on the real smoke result.

### Constraint

- No DeepSeek official Messages credentials; OpenCode Go exposes DeepSeek
  through an OpenAI-compatible provider (`@opencode/ai/providers/openai-compatible`).
- Therefore this round validates real model/tool/usage/cost behavior, but **not**
  the official DeepSeek Messages protocol route.

### Files

- `plugin/index.ts` — budget stop no longer interrupts the current step.
- `test/plugin.test.ts` — assert no interrupt, tool blocking, 402 rewrite.
- `README.md`, `GUIDE.md`, `PROGRESS.md`.

### Decisions

- Let the current step finish before enforcing a USD/GPU stop. Interrupting
  immediately after the usage event cut off the assistant response and produced
  an empty message in the real smoke.
- The next `model.request` is still routed to the local 402 endpoint, and all
  tools except `cost_report` and job status/log/cancel remain blocked. This
  stops further provider spend without destroying the current answer.
- The synthetic budget notice remains best-effort and may be queued until the
  session drains.

### Results — 2026-10-23

- Workspace `bun test`: **113 pass, 0 fail**, 13 files, 455 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` clean;
  `bun build` success (15 modules, 188.22 KB).
- Real OpenCode Go cost smoke:
  - first prompt cost `$0.001612458`, 11,238 tokens, 1 step, agent `build`;
  - second prompt called `cost_report`, which returned task scope, the same
    cost, and agent `build`.
- Real OpenCode Go budget smoke (`budgetUSD: 0.0001`):
  - first prompt completed with `ready`, cost `$0.001410858`;
  - second prompt left session cost unchanged (no additional provider request),
    failed with `provider.quota` / `budget_exceeded` (HTTP 402), and showed the
    budget notice;
  - the first step was not interrupted.
- Tool count remains **25** advertised (13 plugin tools).
- Git commit: `683ac42`.

### Known limitations

- Official DeepSeek Messages route still unvalidated.
- The synthetic notice can be queued until the session next drains.
- USD is provider-reported local accounting, not cloud billing.
- GPU hours only include tagged job records; task/session GPU scopes do not run
  the global job-cancelling monitor.
- No scheduler adapter or persistent Python kernel yet.

### Next

- Choose a scheduler adapter (SLURM/SSH/K8s) or background Best-of-N.
- Validate official DeepSeek Messages if credentials become available.
- Add a user-facing zero-model-call cost panel command if needed.

## Round 11 — 2026-10-23

### Scope

Add a scheduler adapter for long jobs. The local detached runner remains the
default; Round 11 adds a SLURM provider that works locally or through SSH.

### Files

- `plugin/scheduler.ts` — SLURM command runner, submission, status, logs,
  cancellation, and remote file reads.
- `plugin/jobs.ts` — provider branch for start/reconcile/logs/cancel, remote
  metrics, scheduler metadata in job records and experiments.
- `plugin/index.ts` — scheduler options and job manager wiring.
- `test/scheduler.test.ts`, `test/jobs-scheduler.test.ts`.
- `test/config.test.ts`, `examples/opencode.deepseek.jsonc`, docs.

### Decisions

- Keep the local runner untouched as the default. `scheduler: "slurm"` is
  opt-in; `schedulerHost` switches scheduler commands to SSH, otherwise `sbatch`
  runs on the local machine.
- Submit with `sbatch --parsable --wrap` and include `--job-name`, output/error
  paths, `--chdir`, `--time`, `--export=ALL`, optional partition/account/qos/
  GRES, and raw `schedulerExtraArgs`.
- `gpu` means `CUDA_VISIBLE_DEVICES` for local jobs and a SLURM GRES value for
  SLURM jobs. It is not a GPU allocation guarantee.
- Status uses `sacct` first and `squeue` as fallback; terminal accounting uses
  `sacct` exit codes. `scancel` cancels. Logs use remote `tail`, metrics use
  remote `head`.
- A job that disappears from both `sacct` and `squeue` is marked failed with an
  explanatory error rather than left running forever.
- Remote `cwd`, log paths, and metrics paths are interpreted on the scheduler
  host. The default remote directory is `~/.opencode-deepseek/jobs`; `~` is
  expanded remotely.
- SSH defaults to `BatchMode=yes` and a 10s connect timeout; users can override
  with `schedulerSshOptions`.
- Generic SSH-only jobs and K8s remain future work; this round does not claim
  them.

### Results — 2026-10-23

- Workspace `bun test`: **123 pass, 0 fail**, 15 files, 519 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` clean;
  `bun build` success (16 modules, 204.22 KB).
- Scheduler unit tests cover sbatch arguments, SSH transport, sacct state
  mapping, squeue fallback, log tail, scancel, remote metrics, and invalid job
  ids.
- Job integration tests cover remote submission metadata, status/experiment
  synchronization, remote logs, and cancellation/aborted experiments.
- OpenCode 2.1.3 smoke with fake `sbatch`/`sacct`/`squeue`/`scancel` scripts and
  a fake provider: `job_start` persisted `schedulerID: "4242"` and a remote log
  path; `job_status` reconciled to `completed` with exit code 0; `job_logs`
  returned `hello from slurm`.
- Tool count remains **25** advertised (13 plugin tools).
- No real SLURM cluster was available; provider commands are tested through an
  injected runner and fake command scripts.
- Git commit: `6599eb2`.

### Known limitations

- No live SLURM/K8s cluster validation.
- `sacct` is required for reliable terminal accounting; purged jobs are marked
  failed.
- Remote logs/metrics assume a shared filesystem or an SSH-reachable log path.
- No generic SSH-only provider and no Kubernetes provider.
- No persistent Python kernel yet.

### Next

- K8s or generic SSH provider, if needed.
- Validate on a real SLURM cluster.
- Background Best-of-N or persistent Python kernel.
- Add a user-facing zero-model-call cost panel command if needed.

## Round 12 — 2026-10-23

### Scope decision

Target workflow: literature review, research-gap finding, brainstorming, initial
code scaffolding, result analysis, and data visualization. Experiments run on a
Linux server outside OpenCode, so Mac-side job submission and monitoring are not
part of the product profile.

### Removed from the plugin profile

- `job_start` / `job_status` / `job_logs` / `job_cancel` / `job_list`
- local detached job runner and completion notifications
- SLURM provider (local and SSH)
- automatic shell-experiment recording
- GPU-hour accounting and GPU budget monitor

### Retained

- research rules, effort routing, output budgets, cache audit
- research compaction and tool-result spill
- manual experiment registry (`exp_*`)
- fresh-process `run_code` with artifacts/plots
- `verify` and final-answer gate
- synchronous `best_of_n`
- agent presets, skills, commands
- USD `cost_report` and USD budget guard

### Needed but not developed

| Feature | Why it matters | Status |
|---|---|---|
| Persistent Python kernel | Keep variables/data/imports across analysis calls | Done in Round 13 |
| Background Best-of-N | Avoid blocking gap/brainstorm candidate runs | Done in Round 14 |
| Installation/global config | Load the plugin in daily OpenCode | Deferred |
| Zero-model `/cost` command | Inspect cost without a model turn | Optional |
| Official DeepSeek Messages validation | Validate the native provider route if switching | Blocked: no credentials |

K8s, generic SSH-only jobs, real SLURM validation, multi-server locks, GPU
allocation, and cloud billing are explicitly out of scope for this profile.

### Results — 2026-10-23

- Workspace `bun test`: **95 pass, 0 fail**, 358 assertions.
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` clean;
  `bun build` success (13 modules, 146.26 KB).
- Plugin tools: **8** (`cost_report`, four `exp_*`, `verify`, `best_of_n`,
  `run_code`); **20** advertised tools including OpenCode built-ins.
- Removed-feature source/test files were emptied and are no longer imported.
  The workspace shell cannot unlink files, so empty placeholders remain on disk;
  they do not participate in the build or test count.
- Git commit: `4dc9bad`.

### Next

- Implement a persistent Python kernel for `run_code`.
- Keep `best_of_n` synchronous unless asynchronous execution becomes necessary.
- Defer installation/global config until development and validation finish.

## Round 13 — 2026-10-23

### Scope

Add an opt-in persistent Python kernel for `run_code`, so repeated analysis and
plotting calls in one session can reuse imports, variables, and loaded data. The
fresh-process runner remains the default.

### Files

- `plugin/kernel.ts` — per-session Python process, JSON-line protocol, capped
  stdout/stderr, per-call files, timeout kill/restart, network guard, shutdown.
- `plugin/runtime.ts` — persistent branch, per-call runDir/result/artifacts,
  experiment ingestion, fresh/persistent dispatch.
- `plugin/index.ts` — `runCodeKernel` option, kernel manager lifecycle.
- `test/kernel.test.ts`, `test/config.test.ts`, `examples/opencode.deepseek.jsonc`.

### Decisions

- `runCodeKernel` defaults to `"fresh"`; `"persistent"` is opt-in.
- One kernel per session, serialized calls. Different sessions never share state.
- Each call still gets its own runDir, `code.py`, `result.json`, stdout/stderr,
  artifacts directory, and experiments JSONL.
- `result` is removed before each call to avoid stale values; `tools` is reused.
- A wall-timeout kills the kernel; the next call starts a new one.
- Memory is capped at kernel start. Persistent mode does not enforce per-call
  `cpuSec`; fresh mode retains CPU/wall/memory limits.
- Network is blocked by default via the same advisory socket guard; `network:
  true` allows it for that call.
- Persistent stdout/stderr are Python-level capped writers; native C-level writes
  may bypass the cap.

### Results — 2026-10-23

- Workspace `bun test`: **100 pass, 0 fail**, 377 assertions (16 files; 4 empty
  placeholders for removed features).
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` clean;
  `bun build` success (14 modules, 165.93 KB).
- Kernel tests cover state reuse, session isolation, result reset, output capture,
  network blocking, timeout recovery, and manager cleanup.
- Plugin tools remain **8**; **20** advertised including OpenCode built-ins.
- Git commit: `4dc9bad`.

### Known limitations

- Persistent mode is per process; a crashed kernel loses all state.
- No per-call CPU limit in persistent mode; wall timeout kills the kernel.
- Memory limit is set at kernel start, not per call.
- Python-level stdout/stderr capture may miss native C writes.
- Background Best-of-N remains unimplemented and synchronous `best_of_n` is
  still the only multi-candidate mode.

### Next

- Background Best-of-N, if long gap/brainstorm candidate runs become a bottleneck.
- Installation/global config after development and validation.
- Optional zero-model `/cost` command.

## Round 14 — 2026-10-23

### Scope

Add background Best-of-N so long gap/brainstorm candidate runs do not block the
parent tool call. The synchronous path remains the default.

### Files

- `plugin/bestofn.ts` — `background` option, background manager, status/cancel
  tools, progress callbacks, completion notification.
- `plugin/index.ts` — manager lifecycle and `bestOfNNotify` option.
- `test/bestofn.test.ts`, `test/plugin.test.ts`, `test/config.test.ts`,
  `examples/opencode.deepseek.jsonc`.

### Decisions

- `best_of_n` defaults to synchronous. `background: true` returns immediately
  with a `runID`.
- `best_of_n_status` reads persisted progress/result; `best_of_n_cancel`
  interrupts candidate/judge child sessions.
- Status is stored under `bestofn-bg:<projectID>:<runID>`; the full result is
  also stored under `bestofn:<projectID>:<runID>`.
- A completed background run posts a synthetic `<best-of-n ...>` message to the
  parent session when `bestOfNNotify` is true.
- Background execution is in-process. A server restart marks running records
  `interrupted`; there is no resume.
- Candidate/judge progress is persisted through callbacks; callbacks cannot break
  the run.

### Results — 2026-10-23

- Workspace `bun test`: **102 pass, 0 fail**, 386 assertions (16 files; 4 empty
  placeholders for removed features).
- Temp copy with real `@opencode/plugin@2.1.3`: `tsc --noEmit` clean;
  `bun build` success (14 modules, 176.49 KB).
- Plugin tools: **10**; **22** advertised including OpenCode built-ins.
- Tests cover background start, status polling, judge result, completion
  notification, cancellation/interrupts, and the three-tool surface.
- Git commit: `5cc0182`.

### Known limitations

- Background runs are in-process; a server restart marks them interrupted.
- No resume after restart.
- Completion notification wakes the parent session and may consume model tokens.
- Background runs still count against the same USD budget guard as foreground
  calls.

### Next

- Installation/global config after development and validation.
- Optional zero-model `/cost` command.
- Official DeepSeek Messages validation when credentials are available.


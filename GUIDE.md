# OpenCode × DeepSeek V4.1 Flash 1017 科研能力改进指导

> 版本：1.14
> 日期：2026-10-23  
> 适用：OpenCode V2（>= 2.1）、DeepSeek V4.1 Flash 1017（`deepseek-flash`）  
> 参考基线：`anomalyco/opencode@c93aaae`、`deepseek-ai/deepseek-harness@687f282e`  
> 读者：平台工程师、科研工具链维护者、Agent 评测负责人

---

## 0. 摘要

目标不是把 OpenCode 改造成另一个 DSH，而是用最小的上游侵入，把 DeepSeek V4.1 Flash 1017 在**长程科研任务**上的能力释放出来。

三句话结论：

1. **不要 fork agent loop。** OpenCode V2 的 event-sourced 会话、durable inbox、tool snapshot 是资产；真正的缺口在协议适配、上下文策略和科研原语。
2. **优先做 P0 三件事**：DeepSeek Messages 协议、按阶段路由 reasoning effort、收紧输出预算。预计 1–2 周，能拿回大部分“白丢的分”。
3. **一切以内部评测为准。** 不追 AA 综合分；用 30–100 道贴近真实科研流程的题，测质量、成本、缓存命中率和失败率。

预期节奏：

| 阶段 | 周期 | 目标 |
|---|---|---|
| P0 | 1–2 周 | 协议正确、effort 可控、输出不浪费、缓存可测 |
| P1 | 2–6 周 | 科研压缩、工具结果裁剪、实验登记 |
| P2 | 6–12 周 | Python 运行时、长任务、验证闭环、best-of-N |
| P3 | 持续 | 科研预设、技能库、可观测性、上游贡献 |

---

## 1. 背景与判断

### 1.1 能力现状

按 Artificial Analysis Intelligence Index v4.3.2：

| 模型 | 综合分 | 强项 | 弱项 |
|---|---:|---|---|
| GPT-6.1 Sol | 52 | 知识、推理、长程终端、文档理解 | 贵、慢 |
| DeepSeek V4.1 Flash 1017 | 45 | agentic 工作流、办公自动化、速度、价格 | 闭卷知识、HLE、物理、专业文档 |
| GPT-6 Luna | 38 | 极低成本 | 综合能力弱一档 |

DeepSeek 的相对优势是**便宜、快、1M 上下文、开放权重**；相对劣势是**参数化知识与深度推理**。因此策略不是“让模型更聪明”，而是：

- 把闭卷问答改造成**开卷 + 工具 + 验证**；
- 用价格差换**测试时计算**；
- 用 harness 的上下文管理弥补**长程一致性**。

### 1.2 为什么是 OpenCode

OpenCode V2 已经具备改造所需的缝：

- event-sourced 会话日志与崩溃恢复；
- 每次请求捕获 tool snapshot；
- `native` 字段专门承载 provider 私有回放数据；
- Anthropic Messages 协议已支持 `thinking` + `signature`、`output_config.effort`、cache breakpoints；
- 插件系统提供 `context`、`compaction`、`execute.before/after` 等 hook；
- 子代理支持后台运行与独立模型。

缺的不是“内核”，而是**DeepSeek 专用适配层**和**科研原语**。

### 1.3 与 DSH 的关系

DSH 是 DeepSeek 官方的参考实现，值得借鉴：

- 原生 Messages 接入（`https://api.deepseek.com/anthropic`）；
- `systemPromptUpdate: in-history`、`toolUpdate: addition-only`；
- 压缩复用 warm prefix，压缩前裁剪工具结果；
- PTC（Node / 实验性 Python）、spill、jobs、token-meter。

但不要把 OpenCode 改成 DSH。正确关系是：

```text
DSH = 参考实现 / 能力上限
OpenCode = 集成目标 / 日常入口
DeepSeek 适配层 = 可独立维护的 provider + plugin
```

---

## 2. 目标与非目标

### 2.1 目标

1. **协议正确**：DeepSeek 走 Messages 协议时，thinking、signature、effort、缓存计量都不丢。
2. **上下文可控**：长会话中实验状态、指标、失败原因不被压缩掉。
3. **科研可复现**：seed、config、dataset hash、git SHA、metrics、artifacts 可追溯。
4. **成本可测**：每任务 token、缓存命中、美元成本、墙钟时间可观测。
5. **维护可持续**：以插件和上游 PR 为主，fork 只作为短期逃生舱。

### 2.2 非目标

- 不重新训练模型；
- 不追求在 HLE / CritPt 上正面超过 Sol；
- 不重写 agent loop；
- 不把 OpenCode 变成 DSH 的复刻；
- 不默认使用 1M 上下文或 256K 输出。

---

## 3. 设计原则

### 3.1 分层，不混层

```text
┌──────────────────────────────────────────────┐
│ 科研原语：exp / run_code / job / cite / verify │
├──────────────────────────────────────────────┤
│ 策略层：effort 路由、输出预算、压缩策略、缓存纪律 │
├──────────────────────────────────────────────┤
│ 投影层：OpenAI Chat / Anthropic Messages / ... │
├──────────────────────────────────────────────┤
│ 内容层：canonical message + native replay data │
├──────────────────────────────────────────────┤
│ 持久层：event-sourced session log             │
└──────────────────────────────────────────────┘
```

换协议只动投影层；memory policy 只动策略层；不要把 wire JSON 写进持久层。

### 3.2 缓存优先

DeepSeek 的缓存是前缀缓存，命中价约为输入价的 1/50。任何会重写前缀的操作都要有理由：

- system prompt 变更 → 追加，不改头；
- 工具定义 → 只增不重排，删除用声明式 removal；
- 时间戳 / 随机 ID → 不放在前缀；
- 压缩触发 → 留足 margin，避免“刚好超了再重写”。

### 3.3 失败降级，不失败整轮

- signature 无效 → 丢弃 signature，保留文本与工具历史；
- 跨模型 / 跨 provider → 不重放 native 数据；
- 压缩失败 → 保留最新 durable surface，继续用全量历史；
- 工具输出超限 → 落盘 + head/tail，不丢执行结果。

### 3.4 可测量

每个改动都要能回答三个问题：

1. 质量变了吗？
2. 成本变了吗？
3. 缓存命中变了吗？

没有内部评测集的改动，不上生产。

### 3.5 上游优先

- 通用能力 → 上游 PR；
- DeepSeek 特有 → 独立 provider / plugin；
- 5–20 行且上游不接受 → `bun patch`；
- 超过 100 行 → 重新评估是否值得。

---

## 4. 目标架构

### 4.1 组件

```text
opencode-deepseek/          # provider 包
  src/provider.ts           # Messages 路由、能力声明
  src/capabilities.ts       # native system updates / effort updates
  src/replay.ts             # signature 存取与降级

opencode-research/          # 科研插件
  src/plugin.ts             # hooks: context / compaction / execute.after
  src/effort.ts             # 阶段 → effort
  src/budget.ts             # 阶段 → maxTokens
  src/compaction.ts         # 科研 checkpoint
  src/prune.ts              # 工具结果裁剪 / spill
  src/tools/exp.ts          # 实验登记
  src/tools/run_code.ts     # Python 运行时
  src/tools/job.ts          # 长任务
  src/tools/cite.ts         # 文献与引用
  src/tools/verify.ts       # 验证子代理

opencode-conformance/       # 评测与回归
  tasks/                    # 30–100 道内部题
  runner.ts                 # A/B、成本、缓存、失败率
  baselines/                # 历史结果
```

### 4.2 关键缝

| 缝 | 位置 | 用途 |
|---|---|---|
| `SessionMessage.AssistantReasoning.native` | `packages/schema/src/session-message.ts` | provider 私有回放数据 |
| `AnthropicThinkingBlock.signature` | `packages/ai/src/protocols/anthropic-messages.ts` | thinking 原样回放 |
| `supportsEffortUpdates` | `packages/ai/src/route/client.ts` | route 级 effort 更新 |
| `supportsNativeSystemUpdates` | `packages/ai/src/protocols/anthropic-messages.ts` | 会话中 system 更新（当前仅 Claude） |
| `session.hook("context")` | `packages/plugin/src/effect/session.ts` | 改 system / messages / options |
| `session.hook("compaction")` | 同上 | 自定义摘要或直接给 `result` |
| `execute.after` | `packages/plugin/src/effect/tool.ts` | 裁剪、落盘、记录实验 |
| `ctx.tool.transform` | 插件 API | 注册 `exp` / `run_code` / `job` |

> 以上路径以 `opencode@c93aaae` 为准；升级后先跑 conformance，再改代码。

---

## 5. 路线图

### P0：协议与请求层（1–2 周）

#### P0-1 DeepSeek Messages provider

**问题**：当前 DeepSeek 走 `@ai-sdk/openai-compatible` + `/v1/chat/completions`，thinking、effort、缓存计量都不是原生语义。

**改动**：

- 新增 provider 路由，使用 `@opencode/ai/providers/anthropic-compatible`，baseURL 指向 `https://api.deepseek.com/anthropic`；
- 模型 id 使用 `deepseek-flash`；
- 声明 `thinking` / `signature` / `output_config.effort` 能力；
- 保持 `native` 字段原样回放。

**配置草图**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "deepseek": {
      "package": "@opencode/ai/providers/anthropic-compatible",
      "env": ["DEEPSEEK_API_KEY"],
      "settings": {
        "baseURL": "https://api.deepseek.com/anthropic"
      },
      "models": {
        "deepseek-flash": {
          "name": "DeepSeek V4.1 Flash 1017",
          "limit": { "context": 1000000, "output": 393216 },
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
            "reasoning": {
              "supported": true,
              "effort": ["low", "high", "max"]
            }
          },
          "cost": {
            "input": 0.3,
            "output": 1.2,
            "cache": { "read": 0.006 }
          }
        }
      }
    }
  }
}
```

**验收**：

- 10 轮工具调用 + thinking，signature 能原样回放；
- 中途改 system，不触发整段前缀失效（若 native system updates 已启用）；
- 图片输入走可用的引用方式，不每轮 base64 重发；
- 失败时能看到结构化错误，而不是只靠字符串匹配。

**回滚**：保留 OpenAI-compatible 路由作为 fallback；配置切换即可。

#### P0-2 Effort 路由

**问题**：当前只暴露 `low / high / max`，且所有请求一个默认值。

**策略**：

| 阶段 | Agent | Effort | 理由 |
|---|---|---|---|
| 文献检索 | `scout` | `low` | 主要是工具调用与摘要 |
| 实验执行 | `experimenter` | `high` | 需要多步推理 |
| 数据分析 | `analyst` | `high` | 需要计算与核对 |
| 评审 / 红队 | `critic` | `max` | 需要找漏洞 |
| 写作 | `writer` | `low` | 结构化输出为主 |
| 压缩摘要 | `compaction` | `low` | 只做信息压缩 |

**实现**：

```ts
import { Plugin } from "@opencode/plugin"

function effortFor(agent: string): "low" | "high" | "max" {
  if (agent === "critic") return "max"
  if (agent === "scout" || agent === "writer") return "low"
  return "high"
}

export default Plugin.define({
  id: "deepseek.research.effort",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      event.options.reasoningEffort = effortFor(event.agent)
    })
  },
})
```

**验收**：同一批任务，critic 的漏检率下降；scout 的成本下降；总质量不退化。

#### P0-3 输出预算

**问题**：`OUTPUT_TOKEN_MAX = 256_000`，DeepSeek 每任务输出约 89K token，是 Sol 的 2.3 倍。

**策略**：

| Agent | 默认 `maxTokens` | 上限 |
|---|---:|---:|
| `scout` | 8,000 | 16,000 |
| `experimenter` | 16,000 | 64,000 |
| `analyst` | 16,000 | 64,000 |
| `critic` | 16,000 | 64,000 |
| `writer` | 32,000 | 64,000 |
| `compaction` | 12,000 | 16,000 |

**实现**：

```ts
await ctx.session.hook("context", (event) => {
  event.options.maxTokens = maxTokensFor(event.agent)
})
```

**验收**：每任务输出 token 下降 40% 以上，质量不退化；长答案场景可显式提高。

#### P0-4 缓存审计

**改动**：

- 记录每请求 `input / cache read / cache write / output / reasoning`；
- 记录 system、tools、history 的 token 占比；
- 记录 prefix 变更原因（system 改、工具改、压缩、模型切换）。

**验收**：能回答“这次为什么没命中缓存”；长会话缓存命中率目标 ≥ 70%。

---

### P1：上下文与科研状态（2–6 周）

#### P1-1 科研版 compaction

**问题**：默认模板是 Objective / Work State / Relevant Files，适合 coding，不适合科研。

**新模板**：

```md
## Objective
## Hypotheses
## Experiment Registry
| id | config | seed | dataset | git | metrics | status |
## Decisions
## Failed Attempts
## Open Questions
## Next Experiments
## Artifacts
## Citations
## Constraints
```

**配置**：

```jsonc
{
  "compaction": {
    "auto": true,
    "buffer": 65536,
    "keep": { "tokens": 120000 }
  }
}
```

**实现方式**：

- 优先用 `session.hook("compaction")`，自己调用一次低 effort 摘要，返回 `event.result = { summary }`；
- 不改 `compaction.ts` 主体；
- 摘要只读文本与工具结果，不读 reasoning。

**验收**：压缩后仍能回答“上次实验的 seed、配置、指标、失败原因”。

#### P1-2 工具结果裁剪 / spill

**问题**：训练日志、评估输出、PDF 文本会迅速吃满上下文。

**策略**：

- `execute.after` 检查输出大小；
- 超过阈值：全文写 `.opencode/artifacts/<session>/<callID>.txt`；
- 模型只看到 head 2K + tail 2K + 路径 + `grep` 提示；
- 压缩前先裁剪，再决定是否摘要。

**验收**：单次 10MB 日志不导致上下文爆炸；模型能按路径回读。

**实现（Round 2–3）**：`execute.after` 同时处理字符串和文本 part 数组（shell 返回数组）；超过 `toolResultLimit`（默认 32K 字符）时，全文写入 `os.tmpdir()/opencode-deepseek-research/<session>/<callID>.txt`（`0700` 目录、`0600` 文件），上下文保留 head/tail 预览与路径。文件 part 保留；多个文本 part 合并为一个预览。

#### P1-3 实验登记 `exp`

**Schema**：

```sql
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  hypothesis TEXT,
  config_json TEXT,
  seed INTEGER,
  dataset_hash TEXT,
  git_sha TEXT,
  command TEXT,
  metrics_json TEXT,
  status TEXT,
  started_at TEXT,
  finished_at TEXT,
  artifacts_json TEXT
);
```

**工具 API**：

- `exp_record`：记录一次运行；
- `exp_query`：按 id / 状态 / 指标查询；
- `exp_compare`：比较两次运行的指标；
- `exp_best`：按目标指标选最佳。

**自动记录**：

- `execute.after` 解析 shell 命令，识别 `python train.py`、`sbatch`、`torchrun`；
- 记录 cwd、git SHA、环境变量白名单、命令行、退出码；
- 指标由后续 `metrics` 工具补齐。

**验收**：任意一次实验可在 30 秒内复现其配置与数据版本。

**实现（Round 3）**：

- 四个 direct tools（`options: { codemode: false }`）：`exp_record`、`exp_query`、`exp_compare`、`exp_best`；
- 记录存于 `ctx.storage`，key 为 `exp:<projectID>:<experimentID>`；字段覆盖上表，另加 `cwd`、`createdAt`、`updatedAt`；
- `exp_query` 支持 id / 状态 / 指标 + min/max；`exp_compare` 返回指标 delta/pct、config diff、seed/dataset/git 差异；`exp_best` 默认按 `completed` 指标降序；
- `execute.after` 自动识别 `python … .py`、`torchrun`、`accelerate launch`、`deepspeed`、`sbatch`，记录命令、cwd、seed、退出码、环境变量白名单、git SHA、spill 路径；`sbatch`/后台任务记为 `running`；
- 相对 artifact 路径按项目目录规范化，绝对路径和 `s3://` / `wandb://` 等 URI 保留。

> 偏差：为保持 plugin-only，未创建独立 SQLite 表；使用 OpenCode plugin KV。查询通过 `storage.scan` 的项目前缀完成。

---

### P2：科研运行时（6–12 周）

#### P2-1 Python `run_code`

**设计**：

- 每次调用一个 fresh CPython 子进程，或可选持久 kernel；
- 预装 `numpy / pandas / scipy / sklearn / matplotlib / torch`；
- 暴露 `tools.*` 绑定；
- 预算：CPU 60s、wall 600s、内存 2GB、输出 64KB；
- 返回值：`{ value, stdout, stderr, artifacts }`；
- 大数组只回 shape / dtype / head；
- 默认 workspace-write，网络默认关闭。

**验收**：一次片段完成“读数据 → 跑评估 → 画图 → 返回指标”，模型上下文只增加 < 2K token。

**实现（Round 4）**：

- `run_code` 直接工具，默认每次 `python3 -I` fresh 子进程；写入 `runs/<session>/<call>/` 下的 `code.py`、`runner.py`、`config.json`、`result.json`、`stdout.txt`、`stderr.txt`；
- Round 13 增加 opt-in 持久 kernel：`runCodeKernel: "persistent"`，按 session 复用一个 Python 进程，保留变量/import/数据；每次调用仍创建独立 runDir/result/stdout/stderr，wall timeout 会杀掉 kernel，下一次调用重启；内存上限在 kernel 启动时设置，持久模式不按调用执行 `cpuSec`；
- `tools.result(value)` / `result` 变量返回值；NumPy / pandas / torch 对象只返回 shape、dtype、head；
- `tools.artifact(path)`、`tools.savefig(name)`、`tools.exp_record(**kwargs)`；实验调用写入 JSONL，进程结束后由插件写入 registry；
- wall 600s、CPU 60s、内存 2GB（macOS 上 `RLIMIT_AS` 可能不可用，尽力而为）、每流输出 64KB；
- 工具结果只返回有界预览和完整文件路径，避免大输出进入上下文；
- 默认通过 Python socket guard 阻挡外网；这是 advisory，不是 OS 沙箱。

#### P2-2 长任务 `job`

**API**：

- `job_start(command, cwd, env, gpu, timeout)`
- `job_status(id)`
- `job_logs(id, tail)`
- `job_cancel(id)`
- `job_list()`

**要求**：

- 状态持久化到 SQLite；
- 日志落盘；
- 完成时发事件通知；
- 跨 OpenCode 重启存活；
- 可接 SLURM / SSH / K8s provider。

**验收**：训练任务跑 8 小时，会话压缩/重启后仍能查状态与日志。

**历史实现（Round 4/11；Round 12 已移出当前 profile）**：

> 以下内容仅作历史记录。当前插件不再注册 `job_*`，也不创建 job manager/notifier/SLURM provider。

- `job_start`、`job_status`、`job_logs`、`job_cancel`、`job_list` 五个 direct tools；
- 使用 detached Python runner 启动命令，命令在独立 session 中运行；日志写 `output.log`，状态原子写 `status.json`；
- job 元数据写 `ctx.storage`，key 为 `job:<projectID>:<jobID>`；OpenCode 重启后仍可查询；
- `job_start` 可传 `hypothesis` 创建关联实验；传 `metricsPath` 时，任务结束后读取 JSON 数字指标并合并到实验；
- `job_cancel` 杀掉 runner 与 child process group；关联实验标记 `aborted`；
- `gpu` 只设置 `CUDA_VISIBLE_DEVICES`，不负责分配 GPU；
- 完成时通过 `ctx.session.synthetic` 向启动会话注入 `<job ...>` 消息；默认 `delivery: "queue"`、`resume: true`，空闲会话会被唤醒；
- job record 保存 `sessionID`、`notifiedAt`、`notificationAttempts`；失败重试 3 次；`notify: false` 或 `jobNotifications: false` 可关闭；
- Round 11 增加 SLURM provider：`scheduler: "slurm"`，可选 `schedulerHost` 走 SSH，`schedulerRemoteDir`、`schedulerPartition`、`schedulerAccount`、`schedulerQos`、`schedulerExtraArgs`、`schedulerSshOptions`；
- SLURM 提交使用 `sbatch --parsable --wrap`，状态用 `sacct`（回退 `squeue`），取消用 `scancel`，日志/指标通过 `tail`/`head` 读取；`cwd` 解释为远端路径，`gpu` 作为 GRES 请求（如 `1`、`gpu:a100:1`）；
- 限制：尚未实现通用 SSH-only provider 和 K8s；`sacct` 丢失终态时 job 会被标记 failed；远端路径假设登录节点与计算节点共享文件系统；未在真实 SLURM 集群验证。

#### P2-3 验证工具 `verify`

**检查项**：

- 数字复算；
- 单位/量纲；
- 置信区间与 seed 方差；
- 引用是否存在；
- baseline 是否公平；
- 代码是否可运行。

**输出**：

```json
{
  "pass": false,
  "issues": [
    { "type": "metric", "detail": "Table 2 的 73.4 无法从日志复算" }
  ],
  "evidence": ["runs/exp-17/metrics.json"]
}
```

**门禁**：最终答案若含未复算数字或无效引用，打回重写。

**实现（Round 6，本地版）**：

- `verify` direct tool，输入 `answer` + 结构化 `claims`；支持 `number` / `citation` / `file` / `experiment` / `code`；
- 数字：从 JSON / JSONL / CSV 的路径或 `experiment:<id>` 指标复算，支持绝对 tolerance 与 source 中的 unit；
- 引用：本地路径存在性，URL / DOI / arXiv 用 HEAD（GET fallback）检查；404/410 硬失败；
- 实验：状态、distinct seeds、sample std、可选 0.9/0.95/0.99 t 置信区间、最大 CI 宽度、baseline dataset/config/metric 公平性；
- 代码：Python `compile`、`bash -n`、`node --check`、JSON parse；只做语法检查，不执行训练；
- 答案扫描：数字必须匹配 claim/source，引用必须被 citation claim 覆盖；`strict` 把 warning 升为 error；
- 门禁：监听 `session.execution.succeeded`，读取 `session.context` 最后一条 assistant 文本；如果没有同文本、`pass: true` 的 receipt，注入一条 `<verify-gate state="blocked">` synthetic 消息；只检查根会话，子代理/候选会话不触发；
- receipt 存在 `verify:<projectID>:<sessionID>`，包含答案 hash、pass、issues；新用户 prompt 会使旧 receipt 失效并重置计数；默认每个用户 prompt 最多 1 次门禁；
- `verifyGate: false` 关闭门禁，`verifyNetwork: false` 只做引用语法/路径检查；
- 限制：不做定性断言验证；代码只查语法；答案必须与 verify 的 `answer` 完全一致（trim/换行归一化后），否则会再次门禁。

#### P2-4 Best-of-N

**流程**：

1. 同一任务并行启动 N 个子代理（N=3–5）；
2. 每个子代理独立上下文、独立工具调用；
3. 评审代理按 rubric 打分；
4. 返回最佳答案 + 分歧点。

**成本控制**：只对“高价值、可验证”的任务启用；简单任务走单次。

**实现（Round 7，本地版）**：

- `best_of_n` direct tool：`task` + `n`（3–5）；通过 `ctx.session.create` 创建带 `parentID` 的独立子会话，再用 `prompt` + `wait` 并行执行；
- Round 14 增加 `background: true`：立即返回 `runID`；`best_of_n_status` 查询进度/结果，`best_of_n_cancel` 中断候选/judge；完成时向父会话发 synthetic 通知；状态存 `bestofn-bg:<projectID>:<runID>`；后台运行是进程内的，server 重启后标记 interrupted，不自动恢复；
- 每个候选收到独立上下文和同一任务；候选可自行调用 `verify`，其结果会作为回退排序依据；
- 可选 judge 子会话按 rubric 排序，只返回候选编号、rank 和分歧点，不返回分数；
- judge 失败/超时/JSON 非法时，回退到“有 passing verify receipt 的候选 → 第一个完成候选”；
- 只允许根会话启动，子会话嵌套调用会被拒绝；
- 返回最佳答案、候选摘要、候选 sessionID、judge 排名、disagreements、`runID`；完整运行记录写 `bestofn:<projectID>:<runID>`；
- 成本控制：`bestOfNMaxCandidates`（上限 5）、每候选 timeout、`bestOfNJudge` 开关、judge timeout；Round 12 保留 `budgetUSD` 项目/任务/会话级守卫；
- 限制：默认同模型/同 agent，不做多模型多样性；同步阻塞父工具调用；候选答案在 judge prompt 中截断到 12k 字符；无跨 server 锁。

---

### P3：预设与可观测性（持续）

- Agent 预设：`scout` / `experimenter` / `analyst` / `critic` / `writer`；
- Skills：论文阅读、实验设计、统计审查、LaTeX 表格、rebuttal；
- Commands：`/lit`、`/prereg`、`/ablate`、`/verify`、`/paper`；
- 成本面板：按任务、按 agent、按模型；
- 预算守卫：美元 / GPU 小时超限即停。

**实现（Round 8/9，本地版）**：

- `plugin/presets.ts` 通过 `ctx.agent.transform` 注册五个预设；`editor.update` 仅在 id 不存在时调用，已有用户 agent 不覆盖；`mode: "all"`，并带角色 system prompt；
- 预设自动复用已有 effort/output 路由：`scout`/`writer` low，`experimenter`/`analyst` high，`critic` max；
- `ctx.skill.transform` 注册五个内嵌 skill：`deepseek-paper-reading`、`deepseek-experiment-design`、`deepseek-statistics`、`deepseek-latex`、`deepseek-rebuttal`；`autoinvoke: true`，不需要项目内文件；
- `ctx.command.transform` 注册 `/lit`、`/prereg`、`/ablate`、`/verify`、`/paper`；命令把结构化模板拼到用户输入前，若对应预设存在则先 `switchAgent`，切换失败仍以当前 agent 执行；
- 选项：`agentPresets`、`researchSkills`、`researchCommands` 默认 true；预算选项 `budgetUSD`、`budgetScope`、`budgetNotify`；
- 成本面板（Round 9）：`plugin/cost.ts` 从 `session.step.started/ended` 记录 agent/model 明细，用 `session.usage.updated` 校准累计 USD/tokens，`session.usage.recorded` 记录 title/compaction 辅助调用；KV 键为 `cost:<projectID>:<sessionID>`；`cost_report` 支持按 task/session/agent/model 分组；
- 预算守卫（Round 9/10/12）：`budgetUSD` / `budgetScope`；超限后让当前 step 收尾、阻塞工具，并把后续 `model.request` 的 baseURL 指向本地 402 端点，避免向 provider 发请求；
- 限制：命令是 prompt 模板，不是确定性工作流；预设不覆盖同名用户 agent；预算是本地近似账本（provider 上报 cost），不是云账单；已发出的响应不能中途截断。

---

## 6. 代码落点

| 文件 | 改动 | 风险 |
|---|---|---|
| `packages/ai/src/providers/deepseek.ts` | 新增 Messages 路由 | 低 |
| `packages/ai/src/protocols/anthropic-messages.ts` | `supportsNativeSystemUpdates` 改为 route flag | 中 |
| `packages/ai/src/route/client.ts` | 增加能力字段 | 低 |
| `packages/core/src/session/compaction.ts` | 不改主体；通过 hook 替换摘要 | 低 |
| `packages/core/src/session/model-request.ts` | 可选：按 agent 设置输出上限 | 中 |
| `packages/core/src/session/runner/to-llm-message.ts` | 不改；确认 `native` 透传 | 低 |
| `packages/core/src/tool/plugin/` | 新增 `exp` / `run_code` / `job` | 低 |
| `packages/plugin/src/effect/session.ts` | 不改；使用现有 hook | 低 |

### 6.1 最小插件骨架

```ts
import { Plugin } from "@opencode/plugin"

const RESEARCH_RULES = `
科研模式：
1) 事实性断言必须带来源；无来源写 insufficient evidence
2) 数字必须由工具复算，不心算
3) 先给实验设计，再执行；记录 seed、config、数据版本
4) 结论必须区分相关与因果
`

const BUDGET: Record<string, number> = {
  scout: 8_000,
  experimenter: 16_000,
  analyst: 16_000,
  critic: 16_000,
  writer: 32_000,
}

function effortFor(agent: string): "low" | "high" | "max" {
  if (agent === "critic") return "max"
  if (agent === "scout" || agent === "writer") return "low"
  return "high"
}

export default Plugin.define({
  id: "deepseek.research",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: RESEARCH_RULES })
      event.options.reasoningEffort = effortFor(event.agent)
      event.options.maxTokens = BUDGET[event.agent] ?? 16_000
    })

    await ctx.session.hook("compaction", (event) => {
      event.options.reasoningEffort = "low"
      event.options.maxTokens = 12_000
    })
  },
})
```

### 6.2 实验登记工具骨架

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "exp_record",
    description: "Record an experiment run with config, seed, git SHA and metrics",
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        hypothesis: { type: "string" },
        config: { type: "object" },
        seed: { type: "number" },
        metrics: { type: "object" },
        status: { type: "string" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    execute: async (input) => {
      await ctx.storage.set(`exp/${input.id}`, input)
      return { content: `recorded experiment ${input.id}` }
    },
  })
})
```

> 生产实现应使用 SQLite，而不是 `ctx.storage` 的逐键 JSON；这里只示意接口。

---

## 7. 验证与评测

### 7.1 内部评测集

建议 30–100 题，按真实科研流程分层：

| 类别 | 题数 | 例子 |
|---|---:|---|
| 文献检索 | 10 | 找到某方法的三篇代表作并对比 |
| 实验设计 | 10 | 给定假设，设计消融与统计检验 |
| 代码实现 | 15 | 实现训练循环 / 数据管道 / 评估脚本 |
| 结果分析 | 15 | 从日志复算指标、画图、解释方差 |
| 写作 | 10 | 写 related work / 表格 / rebuttal |
| 复现 | 10 | 按记录重跑一次实验并对齐指标 |

### 7.2 指标

| 指标 | 定义 | 目标 |
|---|---|---|
| Task success | rubric 全通过 | 不低于基线 |
| Factual error | 无法复算/无来源的断言 | 下降 50% |
| Citation validity | 引用真实可查 | ≥ 95% |
| Cost / task | 美元 | 下降 30% |
| Cache hit | cache read / input | ≥ 70% |
| Latency | 墙钟时间 | 不高于基线 |
| Tool failure | 工具调用失败率 | < 5% |

### 7.3 A/B 方法

1. **Baseline**：当前 OpenAI-compatible 路由 + 默认 compaction。
2. **P0**：Messages 路由 + effort 路由 + 输出预算。
3. **P1**：再加科研压缩 + pruner。
4. **P2**：再加 Python / job / verify。

每次只变一层，跑同一批题，记录质量、成本、缓存、失败率。不要一次上全部改动。

### 7.4 回归门禁

- 任何 provider / 协议改动：跑 10 个多轮工具调用用例；
- 任何 compaction 改动：跑 10 个长会话用例；
- 任何工具改动：跑对应类别的 5 个用例；
- 任何 OpenCode 升级：跑全量 30–100 题。

---

## 8. 维护与上游策略

### 8.1 版本策略

- 生产 pin 到具体版本，不自动跟 `latest`；
- 插件 `peerDependencies`：`@opencode/plugin >=2 <3`；
- 每月评估一次升级，先在分支跑 conformance。

### 8.2 CI 矩阵

| 维度 | 值 |
|---|---|
| OpenCode | pinned / latest / next |
| Provider | Messages / OpenAI-compatible |
| Compaction | 默认 / 科研 |
| 任务集 | smoke 10 / full 30–100 |

### 8.3 Patch 预算

| 改动规模 | 方式 |
|---|---|
| 配置 / 插件可实现 | 插件，不改核心 |
| < 20 行 | 上游 PR；被拒则 `bun patch` |
| 20–100 行 | 上游 PR；短期 patch，长期跟进 |
| > 100 行 | 重新评估；优先改设计，不 fork |

### 8.4 上游 PR 清单

1. `supportsNativeSystemUpdates` 改为 route-declared（通用能力，不是 DeepSeek 特判）。
2. 暴露 reasoning effort 的数字/字符串透传（如果当前类型限制）。
3. compaction hook 的 `result` 字段文档化（已存在，补文档与测试）。
4. 工具结果 spill 的通用接口（如果社区需要）。

### 8.5 逃生舱

如果上游出现破坏性变更：

1. 冻结到上一个可用版本；
2. 用 `bun patch` 维持最小差异；
3. 在 2 周内决定：跟进上游 / 永久 fork / 迁移到 DSH。

不要把“临时 patch”养成“永久 fork”。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| signature 失效 | thinking 回放失败 | 降级为纯文本，不失败整轮 |
| 缓存退化 | 成本上升 | 每次改动测 cache hit；稳定前缀 |
| 上游 API 漂移 | 插件失效 | pin 版本 + CI 矩阵 + 契约测试 |
| Go 端点限制 | 拿不到 Messages | DeepSeek 直连 key；Go 只用于其他模型 |
| 评测过拟合 | 虚高质量 | 留出 holdout；定期换题 |
| 数据泄漏 | 科研数据外流 | 本地评测；自托管选项 |
| 过度压缩 | 丢失实验状态 | 科研模板 + 大 retain + artifact 落盘 |
| 工具权限过大 | 误删/误跑 | `execute.before` 门禁 + 预算守卫 |

---

## 10. 附录

### 10.1 关键配置速查

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "buffer": 65536,
    "keep": { "tokens": 120000 }
  },
  "providers": {
    "deepseek": {
      "package": "@opencode/ai/providers/anthropic-compatible",
      "env": ["DEEPSEEK_API_KEY"],
      "settings": { "baseURL": "https://api.deepseek.com/anthropic" }
    }
  }
}
```

### 10.2 术语

- **PTC**：Programmatic Tool Calling，模型写程序调用工具。
- **Warm prefix**：可复用缓存前缀。
- **Native replay data**：provider 私有的回放数据，如 thinking signature。
- **Spill**：把大文本落盘，只把 locator 返回模型。
- **Best-of-N**：并行采样 N 个答案，再由评审选出最佳。

### 10.3 参考

- OpenCode V2 文档：<https://opencode.ai/v2/docs/>
- OpenCode 插件：<https://opencode.ai/v2/docs/build/plugins>
- OpenCode Go：<https://opencode.ai/docs/go/>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- DeepSeek V4.1 Flash 1017 模型卡：<https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017>
- Artificial Analysis：<https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017>

### 10.4 实施状态

| 项目 | 状态 | 位置 |
|---|---|---|
| P0-1 DeepSeek Messages provider | 示例完成，未应用 | `examples/opencode.deepseek.jsonc` |
| P0-2 effort 路由 | 完成 | `plugin/policy.ts`、`plugin/index.ts` |
| P0-3 输出预算 | 完成 | 同上 |
| P0-4 缓存审计 | 完成 | `plugin/policy.ts`、`plugin/index.ts` |
| P1-1 科研 compaction | 完成 | `plugin/policy.ts`、`plugin/index.ts` |
| P1-2 工具结果裁剪 | 完成（字符串 + 文本数组） | `plugin/policy.ts`、`plugin/index.ts` |
| P1-3 实验登记 | 完成（KV-backed） | `plugin/experiments.ts`、`index.ts` |
| P2-1 Python `run_code` | 完成（fresh + opt-in persistent kernel） | `plugin/runtime.ts`、`plugin/kernel.ts` |
| P2-2 长任务 `job` | 移出当前 profile（Round 12） | 历史实现已从插件入口移除 |
| P2-3 verify | 完成（本地，含最终答案门禁） | `plugin/verify.ts`、`plugin/gate.ts` |
| P2-4 best-of-N | 完成（同步 + background/status/cancel） | `plugin/bestofn.ts` |
| P2-5 持久 Python kernel | 完成（opt-in，per-session） | `plugin/kernel.ts`、`plugin/runtime.ts` |
| P3-1 agent presets | 完成（本地，五个预设） | `plugin/presets.ts`、`plugin/index.ts` |
| P3-2 skills | 完成（本地，五个内嵌 skill） | `plugin/presets.ts` |
| P3-3 commands | 完成（本地，五个 slash command） | `plugin/presets.ts` |
| P3-4 成本面板 | 完成（本地，按 task/session/agent/model） | `plugin/cost.ts` |
| P3-5 预算守卫 | 完成（USD，本地 + OpenCode Go 验证） | `plugin/cost.ts`、`plugin/budget-server.ts`、`plugin/index.ts` |

### 当前 profile（Round 12）

目标工作流：文献综述、research gap finding、brainstorming、初步代码搭建、结果分析、数据可视化。代码实验在 Linux server 上执行，OpenCode 不负责提交或监控远端任务。

**保留**：科研规则、effort/输出预算、缓存审计、科研 compaction、工具结果 spill、`exp_*`、`run_code`、`verify`/门禁、同步 `best_of_n`、agent/skill/command 预设、USD 成本面板与 USD 预算守卫。

**移出当前 profile**：`job_*`、本地 detached job、SLURM provider、完成通知、shell 实验自动记录、GPU 小时账本/GPU 预算监控。

**需要但未开发**：

| 功能 | 作用 | 状态 |
|---|---|---|
| 持久 Python kernel | 在多次 `run_code` 间保留变量/数据，提升分析与画图效率 | 已完成（`runCodeKernel: "persistent"`） |
| 后台 Best-of-N | gap/brainstorm 候选异步执行，避免阻塞父会话 | 已完成（`background: true` + status/cancel） |
| 安装/全局配置 | 让插件在日常 OpenCode 中加载 | 开发结束后再做 |
| 官方 DeepSeek Messages 验证 | 切换官方 API 时确认协议兼容 | 阻塞：无凭据 |

OpenCode / Go 订阅已有实时计费，因此不计划单独的零模型 `/cost` 命令；`cost_report` 仅用于按 task/session/agent/model 拆分。

**不需要**：K8s、通用 SSH-only provider、真实 SLURM 验证、多 server 锁、GPU 实际分配、云账单。它们与“Linux server 手动跑实验”的 profile 不匹配。

Round 1 验收：

- `bun test`：17 pass / 0 fail。
- `bun build`：通过。
- Git 首次提交：`7b69b9e`。

Round 2 验收：

- `bun test`：32 pass / 0 fail。
- `bun build`：通过。
- Git 提交：`f518cfb`、`18ce81c`。
- 缓存审计：读取累计 `session.usage.updated`，按 session 写入 storage；大 prompt（≥200K）且命中率 <50% 时告警一次。
- 科研 compaction：注入“目标 / 已确认证据 / 实验状态 / 未决问题 / 下一步”结构要求。
- 工具结果：超过 32K 字符的字符串结果落盘到 `os.tmpdir()`，上下文只保留预览和路径；数组结果暂不处理。
- 详细记录见 [`PROGRESS.md`](./PROGRESS.md)。

Round 3 验收：

- 工作区 `bun test`：52 pass / 0 fail（4 文件，163 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`bun test` 52 pass，`tsc --noEmit` 通过。
- OpenCode 2.1.3 冒烟：插件 `active`；模型请求含 4 个 `exp_*` direct tools；系统提示含科研规则；`max_completion_tokens=16000`；`exp_record` 调用成功并写入 KV。
- Git 提交：`74e1e17`。
- 详细记录见 [`PROGRESS.md`](./PROGRESS.md)。

Round 4 验收：

- 工作区 `bun test`：66 pass / 0 fail（6 文件，228 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`bun test` 66 pass，`tsc --noEmit` 通过。
- `run_code`：读数据、评估、matplotlib 画图、`tools.exp_record` 写实验均通过；上下文只返回预览和路径；wall timeout、输出 cap、网络默认阻断有测试。
- `job`：短任务、失败退出、取消、日志 tail、timeout、metrics JSON 导入、manager 重启后查询均有测试。
- OpenCode 2.1.3 冒烟：22 个工具（含 `run_code` 和 5 个 `job_*`）；`run_code`、`job_start`、`job_status`、`job_logs` 实际执行成功。
- 重启冒烟：杀掉 server 后重启，`job_status` 仍返回 `running` 和原 PID；`job_cancel` 成功取消并把关联实验标记为 `aborted`。
- Git 提交：`b852aa2`。
- 详细记录见 [`PROGRESS.md`](./PROGRESS.md)。

Round 5 验收：

- 工作区 `bun test`：70 pass / 0 fail（7 文件，262 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过。
- OpenCode 2.1.3 推送冒烟：`job_start` 后约 5 秒，notifier 向同一会话注入 synthetic `<job state="completed">` 消息；fake provider 收到第 3 次请求并继续响应。
- 通知记录包含 `sessionID`、`notifiedAt`、`notificationAttempts`；失败重试与去重有单元测试。
- `notify: false` 与 `jobNotifications: false` 可关闭推送。
- Git 提交：`c0bacae`。

Round 6 验收：

- 工作区 `bun test`：88 pass / 0 fail（9 文件，336 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过。
- `verify`：数字（JSON/JSONL/CSV/experiment）、unit、citation（本地/URL/404）、file、seed/CI/baseline、Python/JSON 语法均有单元测试。
- OpenCode 2.1.3 门禁冒烟：最终答案 `73.4%` 被拦截 1 次；fake provider 调用 `verify`，从 `metrics.json` 复算 `73.4` 并保存 receipt；同一答案随后完成，第二次 `session.execution.succeeded` 不再拦截；工具总数为 23。
- 门禁去重、失败 receipt、tool-call 中间消息、无数字答案、`verifyGate: false` 均有测试。
- Git 提交：`c3d641f`。

Round 7 验收：

- 工作区 `bun test`：97 pass / 0 fail（10 文件，379 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过。
- `best_of_n` 单元测试：并行候选、judge 选择、judge 关闭时 verify 回退、候选失败、judge JSON 非法回退、无候选错误、嵌套调用拒绝。
- OpenCode 2.1.3 冒烟：`best_of_n` 创建 3 个候选子会话 + 1 个 judge，6 次 provider 请求（主工具调用、3 候选、judge、主最终答案）；judge 选中候选 2（`73.4%`），返回 `basis: "judge"` 和 disagreement；没有子会话门禁记录。
- 根会话门禁测试：父会话仍拦截，带 `parentID` 的子会话忽略。
- 工具总数：24（12 个插件工具）。
- Git 提交：`697f110`。

Round 8 验收：

- 工作区 `bun test`：103 pass / 0 fail（11 文件，406 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过。
- 预设测试：五个 agent（已有同名不覆盖）、五个 skill（已有同名不覆盖）、五个 command（agent 切换、切换失败降级、空输入提示）。
- OpenCode 2.1.3 冒烟：首次 prompt 激活插件后，`/api/agent` 列出全部五个预设，`/api/skill` 列出五个内嵌 skill，`/api/command` 列出五个命令；执行 `/lit graph neural networks` 后出现 `agent-switched: scout`，请求使用 Scout system prompt、`max_completion_tokens: 8000`、`reasoning_effort: low`。
- Git 提交：`d21ea65`。

Round 9 验收：

- 工作区 `bun test`：113 pass / 0 fail（13 文件，456 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（15 模块，188.98 KB）。
- 成本测试：task/子会话汇总、agent/model 分组、aux usage、USD/task scope、GPU 小时、markdown/JSON、`cost_report` 上下文默认 task。
- 预算测试：超限只触发一次、工具拦截、`model.request` 改写到本地 402、预算通知。
- OpenCode 2.1.3 成本冒烟：`cost_report` 返回 `Scope: task ...`、`$0.000420`、1,100 tokens、1 step、agent `build`。
- OpenCode 2.1.3 预算冒烟：干净 project 第一次 prompt 产生 1 次 provider 请求、cost `$0.000420`，超过 `$0.0001`；下一次 prompt 被本地 402 拦截，provider 请求数保持 1，错误类型 `provider.quota` / `budget_exceeded`，并出现预算通知。
- 工具总数：25（13 个插件工具）。
- Git 提交：`7385a6e`。

Round 10 验收（OpenCode Go）：

- 约束：当前只有 OpenCode Go 订阅中的 DeepSeek；provider 为 `opencode-go/deepseek-v4.1-flash`，实际走 OpenAI-compatible 路由，不是官方 DeepSeek Messages API。
- 工作区 `bun test`：113 pass / 0 fail（13 文件，455 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（15 模块，188.22 KB）。
- 真实成本冒烟：第一次 prompt cost `$0.001612458`、11,238 tokens、1 step；第二次 prompt 的 `cost_report` 返回 task 范围、agent `build`、同额成本。
- 真实预算冒烟：`budgetUSD: 0.0001`，第一次 prompt 正常完成 `ready`，cost `$0.001410858`；第二次 prompt cost 不变、0 次额外 provider 请求，错误为 `provider.quota` / `budget_exceeded`（HTTP 402），并出现预算通知。
- 行为修正：预算超限不再立即 `interrupt` 当前 step，避免空回复；当前 step 收尾，下一步模型请求硬停、工具阻塞。
- Git 提交：`683ac42`。

Round 11 验收（SLURM provider）：

- 工作区 `bun test`：123 pass / 0 fail（15 文件，519 断言）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（16 模块，204.22 KB）。
- 调度器单元测试：`sbatch --wrap` 资源/时间/环境参数、SSH 传输、`sacct` 状态映射（RUNNING/COMPLETED/FAILED/TIMEOUT/CANCELLED）、`squeue` 回退、日志 tail、`scancel`、远端 metrics 读取、非法 job id。
- job 集成测试：SLURM 提交记录 `schedulerID`/`schedulerHost`/`schedulerCwd`/远端 logPath，状态与实验 metrics 同步，远端日志读取，远端取消并标记实验 aborted。
- OpenCode 2.1.3 冒烟（fake `sbatch`/`sacct`/`squeue`/`scancel` + fake provider）：`job_start` 持久化 `schedulerID: "4242"` 和远端 logPath；`job_status` 变为 `completed`、exit code 0；`job_logs` 返回 `hello from slurm`。
- 未在真实 SLURM 集群验证；通用 SSH-only provider 和 K8s 仍未实现。
- 工具总数保持 25（13 个插件工具）。
- Git 提交：`6599eb2`。

Round 12 验收（范围收敛）：

- 工作区 `bun test`：95 pass / 0 fail，358 断言（11 个有效测试文件 + 4 个已移出功能的空占位文件）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（13 模块，146.26 KB）。
- 插件工具：8 个（`cost_report`、4 个 `exp_*`、`verify`、`best_of_n`、`run_code`）；总计 20 个 advertised tools（含 OpenCode built-ins）。
- 移出：`job_*`、本地 job runner、SLURM provider、完成通知、shell 自动记录、GPU 小时账本/GPU 预算。
- 保留：科研规则、effort/输出预算、缓存审计、compaction、spill、`exp_*`、`run_code`、`verify`/门禁、同步 `best_of_n`、presets/skills/commands、USD cost_report/budget。
- 文档已列出“需要但未开发”：安装/全局配置（延后）、官方 Messages 验证（阻塞）；后台 Best-of-N 与持久 Python kernel 已完成；零模型 `/cost` 因 OpenCode/Go 已有实时计费而不做。
- Git 提交：`4dc9bad`。

Round 13 验收（持久 Python kernel）：

- 工作区 `bun test`：100 pass / 0 fail，377 断言（16 文件，含 4 个移出功能的空占位）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（14 模块，165.93 KB）。
- 持久 kernel 测试：同一 session 保留变量/import；不同 session 隔离；每次调用重置 `result`；stdout 按调用捕获；网络默认阻断；超时杀 kernel 后下一次调用恢复。
- 插件工具仍为 8 个；总计 20 个 advertised tools。
- Git 提交：`4dc9bad`。

Round 14 验收（后台 Best-of-N）：

- 工作区 `bun test`：102 pass / 0 fail，386 断言（16 文件，含 4 个移出功能的空占位）。
- 临时副本 + 真实 `@opencode/plugin@2.1.3`：`tsc --noEmit` 通过；`bun build` 通过（14 模块，176.49 KB）。
- 新增工具：`best_of_n_status`、`best_of_n_cancel`；`best_of_n` 支持 `background: true`。
- 测试覆盖：后台启动返回 runID、status 轮询到 completed、judge 结果、完成通知、cancel 后中断候选会话且状态保持 cancelled。
- 插件工具 10 个；总计 22 个 advertised tools（含 built-ins）。
- 限制：后台运行在插件进程内，server 重启后不会恢复；状态会标记 interrupted。
- Git 提交：`5cc0182`。

> 工作区 shell 仍无法写入 `node_modules`，因此本地测试使用 identity shim；
> 临时副本已安装真实 `@opencode/plugin` 并完成测试与类型检查。

### 10.5 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-23 | 1.0 | 初稿：背景、路线图、详细设计、评测、维护策略 |
| 2026-10-23 | 1.1 | Round 1 实施：research rules、effort 路由、输出预算、provider 示例、测试与 Git |
| 2026-10-23 | 1.2 | Round 2 实施：缓存审计、科研 compaction、字符串工具结果 spill、测试与 Git |
| 2026-10-23 | 1.3 | Round 3 实施：实验登记 exp、自动记录、数组 spill、插件选项、真实 OpenCode 冒烟与类型检查 |
| 2026-10-23 | 1.4 | Round 4 实施：Python `run_code`、本地 detached `job_*`、metrics JSON 导入、真实 OpenCode 冒烟 |
| 2026-10-23 | 1.5 | Round 5 实施：job 完成 synthetic 推送、通知去重/重试、真实 OpenCode 推送冒烟 |
| 2026-10-23 | 1.6 | Round 6 实施：verify 数字/引用/实验/代码检查、最终答案 receipt 门禁、真实 OpenCode 门禁冒烟 |
| 2026-10-23 | 1.7 | Round 7 实施：best_of_n 并行子会话、judge rubric、verify 回退、根会话门禁、真实 OpenCode 冒烟 |
| 2026-10-23 | 1.8 | Round 8 实施：五个 agent 预设、五个内嵌 skill、五个 slash command、真实 OpenCode 预设/命令冒烟 |
| 2026-10-23 | 1.9 | Round 9 实施：cost_report、USD/GPU 小时预算守卫、本地 402 拦截、真实 OpenCode 成本/预算冒烟 |
| 2026-10-23 | 1.10 | Round 10：OpenCode Go DeepSeek 真实验证；预算超限改为当前 step 收尾、下一步 402，避免空回复 |
| 2026-10-23 | 1.11 | Round 11：SLURM provider（本地/SSH）、job 状态/日志/取消/metrics 适配、调度器与 job 集成测试 |
| 2026-10-23 | 1.12 | Round 12：按目标工作流收敛范围；移除 job/SLURM/通知/自动记录/GPU 预算；列出未开发需求；下一步持久 Python kernel |
| 2026-10-23 | 1.13 | Round 13：实现 opt-in 持久 Python kernel（per-session 状态、超时重启、网络/内存限制） |
| 2026-10-23 | 1.14 | Round 14：后台 Best-of-N（background/status/cancel、通知、进程内状态） |

# 安装与配置指南

本文说明如何把 `opencode-deepseek-research` 安装到 OpenCode V2，并配置成适合以下工作流的形态：

- 文献综述（literature review）
- Research gap finding
- Brainstorming
- 初步代码搭建
- 结果分析
- 数据可视化

长训练、GPU 分配和 Linux server 上的实验调度不在本插件范围内；这些任务应继续在你的 Linux server 上执行。

> 重要：本文只修改 OpenCode 配置和插件目录，不修改 `/Applications/OpenCode.app`，也不修改 `app.asar`。

---

## 1. 安装前确认

### 1.1 OpenCode

需要 OpenCode V2，建议 `>= 2.1`。查看版本：

```sh
opencode --version
```

### 1.2 插件目录

本文假设插件位于：

```text
/Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research
```

如果你移动了目录，后续所有 `package` 路径都要替换成实际绝对路径。

插件入口是目录下的 `index.ts`：

```ts
export { default } from "./plugin/index.ts"
```

`package.json` 的 `main` / `exports` 也指向这个文件。OpenCode 直接加载这个目录，不需要先构建。

### 1.3 Bun 与依赖

插件使用 Bun 运行测试和加载依赖。检查：

```sh
bun --version
```

如果插件目录下没有 `node_modules`，安装依赖：

```sh
cd /Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research
bun install
```

当前目录已经有 `node_modules/@opencode/plugin`，通常不需要重复安装。

### 1.4 Python

`run_code` 默认使用 `python3`，但为了保证 `numpy` / `pandas` / `matplotlib` 可用，建议显式指定 Anaconda Python：

```sh
/opt/anaconda3/bin/python3 -c "import numpy, pandas, matplotlib; print('python ok')"
```

如果这条命令失败，先修复 Python 环境，或在配置里换成你自己的 Python 绝对路径。

### 1.5 模型

当前全局配置使用：

```text
opencode-go/deepseek-v4.1-flash
```

插件本身不绑定 provider；OpenCode Go 的 OpenAI-compatible 路由已经验证可用。

如果你以后切换到 DeepSeek 官方 Messages API，请参考 `examples/opencode.deepseek.jsonc`，并设置 `DEEPSEEK_API_KEY`。官方 Messages 路由目前尚未做真实凭据验证。

---

## 2. 选择安装方式

### 方式 A：全局安装

写入：

```text
~/.config/opencode/opencode.jsonc
```

效果：所有 OpenCode 项目都会加载插件。

适合：你希望在任何项目里都能直接使用 `/lit`、`cost_report`、`run_code` 等能力。

### 方式 B：项目级安装

写入某个研究项目根目录的：

```text
<project>/opencode.jsonc
```

效果：只在该项目加载插件，其他项目不受影响。

适合：你只想在论文/研究项目里使用，避免影响日常编码项目。

> 如果不确定，建议先做**项目级安装**验证，再迁移到全局配置。

---

## 3. 备份配置

修改前先备份：

```sh
cp ~/.config/opencode/opencode.jsonc \
   ~/.config/opencode/opencode.jsonc.bak-$(date +%Y%m%d-%H%M%S)
```

如果是项目级安装，备份项目的 `opencode.jsonc`。

---

## 4. 全局安装步骤

### 4.1 编辑全局配置

打开：

```text
~/.config/opencode/opencode.jsonc
```

保留你已有的 `provider` 配置和 `srt-shell`，在 `plugins` 数组中追加插件对象。

示意结构：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash",
  "small_model": "opencode-go/deepseek-v4.1-flash",

  // 保持你现有的 provider 配置不变
  "provider": {
    // ...
  },

  "plugins": [
    "/Users/xumou/.config/opencode/plugins/srt-shell",
    {
      "package": "/Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research",
      "options": {
        "toolResultLimit": 32000,
        "cacheMinPromptTokens": 200000,
        "cacheMinHitRate": 0.5,

        "pythonPath": "/opt/anaconda3/bin/python3",
        "runCodeKernel": "persistent",
        "runCodeTimeoutSec": 600,
        "runCodeCpuSec": 60,
        "runCodeMemoryMb": 2048,
        "runCodeNetwork": false,

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

注意：

- `package` 必须是插件目录的**绝对路径**，不是 `index.ts` 路径。
- `plugins` 支持字符串和对象混用；`srt-shell` 保持原样即可。
- 不要加入已经移出的选项：
  - `jobNotifications`
  - `jobDefaultTimeoutSec`
  - `jobNotifyIntervalSec`
  - `scheduler`
  - `schedulerHost`
  - `autoRecordExperiments`
  - `budgetGPUHours`
  - `budgetCheckIntervalSec`
- JSONC 允许注释和尾随逗号，但不要破坏 JSON 结构。

### 4.2 关键选项说明

| 选项 | 建议 | 作用 |
|---|---|---|
| `toolResultLimit` | `32000` | 超过该长度的工具结果落盘，只回预览和路径 |
| `cacheMinPromptTokens` | `200000` | 只对长会话做缓存命中告警 |
| `cacheMinHitRate` | `0.5` | 命中率低于 50% 时告警 |
| `pythonPath` | `/opt/anaconda3/bin/python3` | 确保 numpy/pandas/matplotlib 可用 |
| `runCodeKernel` | `persistent` | 同一 session 复用 Python 变量/import；设为 `fresh` 则每次新进程 |
| `runCodeTimeoutSec` | `600` | `run_code` wall-clock 上限 |
| `runCodeCpuSec` | `60` | fresh 模式的 CPU 上限；persistent 模式不按调用执行 |
| `runCodeMemoryMb` | `2048` | 内存上限（尽力而为） |
| `runCodeNetwork` | `false` | 默认阻断 `run_code` 网络 |
| `verifyGate` | `true` | 最终答案含数字/引用时要求 `verify` receipt |
| `verifyMaxGates` | `1` | 每个用户 prompt 最多拦截一次 |
| `bestOfN` | `true` | 启用 Best-of-N 工具 |
| `bestOfNNotify` | `true` | 后台 Best-of-N 完成后通知父会话 |
| `budgetUSD` | `0` | 插件 USD 预算；0 表示关闭 |
| `budgetScope` | `project` | 预算范围；也可用 `task` 或 `session` |
| `budgetNotify` | `true` | 超预算时发 synthetic 通知 |

关于预算：

- OpenCode / Go 订阅本身已有实时计费；插件 `cost_report` 只提供 **按 task/session/agent/model 的拆分**。
- `budgetUSD: 0` 表示不启用插件预算守卫。
- 如果启用，默认是 project 范围，会跨 session 累计；只想限制单个任务时可改成：

```jsonc
"budgetUSD": 5,
"budgetScope": "task"
```

- 超限后，当前 step 会收尾；下一步模型请求会被本地 402 拦截，工具只允许 `cost_report`。

### 4.3 重载配置

```sh
opencode reload
```

如果插件没有加载，退出并重新打开 OpenCode App，或重启后台服务。

---

## 5. 项目级安装

在项目根目录创建或编辑：

```text
<project>/opencode.jsonc
```

示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research",
      "options": {
        "pythonPath": "/opt/anaconda3/bin/python3",
        "runCodeKernel": "persistent",
        "toolResultLimit": 32000,
        "verifyGate": true,
        "bestOfN": true,
        "bestOfNNotify": true,
        "budgetUSD": 0
      }
    }
  ]
}
```

项目级配置只影响该项目。全局的 `srt-shell` 仍会按全局配置加载。

---

## 6. 验证安装

### 6.1 插件是懒加载的

OpenCode 第一次 prompt 后才会激活插件。刚启动时 `/api/agent`、`/api/skill`、`/api/command` 可能为空，这是正常现象。

新开一个 session，先发一条最小 prompt：

```text
回复 ok
```

然后再验证下面的能力。

### 6.2 验证命令与预设

输入：

```text
/lit graph neural networks
```

预期：

- agent 切换到 `scout`
- 使用 Scout system prompt
- `max_completion_tokens` 约为 `8000`
- `reasoning_effort` 为 `low`

如果命令不存在，检查 `researchCommands` 是否为 `true`，以及插件是否真的加载。

### 6.3 验证成本面板

让模型调用：

```text
调用 cost_report，按 agent 看当前成本
```

预期返回 Markdown 表格，包含 USD、tokens、steps。

`cost_report` 是模型工具；OpenCode / Go 的实时计费仍是总账，插件表只用于拆分。

### 6.4 验证持久 Python kernel

连续两次执行：

```text
用 run_code 执行：x = 41; result = x + 1
```

```text
再用 run_code 执行：result = x + 1
```

如果 `runCodeKernel` 是 `persistent`，第二次应该返回 `42`；如果是 `fresh`，第二次会因为 `x` 不存在而失败。

### 6.5 验证后台 Best-of-N（可选，消耗额度）

让模型：

```text
用 best_of_n 对“比较两种方法”跑 3 个候选，background=true
```

预期立即返回 `runID`。然后：

```text
调用 best_of_n_status，runID 是 ...
```

查看状态和结果。完成后父会话会收到 `<best-of-n ...>` 通知（除非 `bestOfNNotify: false`）。

注意：Best-of-N 会真实产生多次模型调用，不要在无关任务上频繁使用。

### 6.6 查看日志

```sh
tail -100 ~/.local/share/opencode/opencode.log | grep -i deepseek-research
```

没有 `failed to register`、`Cannot find module`、`Model unavailable` 等错误即可。

---

## 7. 常见问题

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 插件工具完全不出现 | 配置未加载 / 路径错误 | 检查 `package` 绝对路径，执行 `opencode reload`，重启 App |
| `Cannot find module '@opencode/plugin'` | 插件依赖缺失 | 在插件目录执行 `bun install` |
| `/lit` 不存在 | 插件未激活或 `researchCommands: false` | 先发一条 prompt，确认配置 |
| `Model unavailable` | 模型/provider 配置或认证问题 | 检查 `model`、provider 和 OpenCode Go 登录 |
| `run_code` 找不到 numpy/pandas | Python 路径不对 | 把 `pythonPath` 指向 `/opt/anaconda3/bin/python3` 或你验证过的 Python |
| `network disabled by run_code` | 默认禁止网络 | 这是预期；确需联网时在 `run_code` 输入里设 `network: true` |
| `budget_exceeded` / HTTP 402 | 插件预算超限 | 提高 `budgetUSD` 或设为 `0`；检查 `budgetScope` |
| 第二次 `run_code` 变量丢失 | 当前是 fresh 模式 | 设 `runCodeKernel: "persistent"` |
| persistent kernel 变量丢失 | 超时杀掉了 kernel / 插件重启 | 重新建立变量；必要时用 fresh 模式 |
| 后台 Best-of-N 状态 `interrupted` | OpenCode 服务重启 | 后台运行是进程内的，不会自动恢复；重新启动 |
| matplotlib cache 警告 | `MPLCONFIGDIR` 不可写 | 在启动 OpenCode 的环境中设置可写目录，例如 `export MPLCONFIGDIR=~/.cache/matplotlib` |
| 成本表与 OpenCode 计费不一致 | 本地记录与订阅账单口径不同 | 以 OpenCode/Go 实时计费为准；插件表用于拆分 |

---

## 8. 升级插件

1. 备份配置。
2. 更新插件目录（`git pull` 或复制新版本）。
3. 如果依赖变化：

```sh
cd /Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research
bun install
```

4. 重载：

```sh
opencode reload
```

5. 按第 6 节重新验证 `/lit`、`cost_report` 和 `run_code`。

---

## 9. 卸载/回滚

### 回滚配置

```sh
cp ~/.config/opencode/opencode.jsonc.bak-你的时间戳 \
   ~/.config/opencode/opencode.jsonc
opencode reload
```

### 移除插件

从 `plugins` 数组删除插件对象，保留 `srt-shell` 等其他插件，然后重载。

插件不修改全局 provider，也不写入系统级路径；卸载配置后不会影响 OpenCode 本身。

可选的清理（不会自动执行）：

```sh
# 临时运行目录
rm -rf /private/var/folders/.../opencode-deepseek-research
```

实际路径以 `os.tmpdir()` 为准；不清理也不影响使用。

---

## 10. 安全与边界

- `run_code` 默认通过 Python socket guard 阻断外网，但这是 **advisory**，不是 OS 沙箱。
- persistent kernel 会保留变量和 import；执行不受信任代码时建议改回 `runCodeKernel: "fresh"`。
- 插件不做本地后台 job、SLURM、K8s、SSH 任务管理，也不分配 GPU。
- 插件不做云账单级计费；USD 是 provider 上报的本地记录。
- 后台 Best-of-N 是进程内运行，OpenCode 重启后会标记 `interrupted`，不会自动恢复。
- 插件不会自动修改你的全局配置；安装需要你手动编辑并 reload。

---

## 11. 最小可用配置

如果只想先跑起来，可以使用最小配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/Users/xumou/.config/opencode/plugins/srt-shell",
    {
      "package": "/Users/xumou/Documents/GitHub/opencode_general/opencode-deepseek-research",
      "options": {
        "pythonPath": "/opt/anaconda3/bin/python3",
        "runCodeKernel": "persistent"
      }
    }
  ]
}
```

其他选项会使用默认值：

- `toolResultLimit`: 32000
- `cacheMinPromptTokens`: 200000
- `cacheMinHitRate`: 0.5
- `runCodeTimeoutSec`: 600
- `runCodeCpuSec`: 60
- `runCodeMemoryMb`: 2048
- `runCodeNetwork`: false
- `verifyGate`: true
- `bestOfN`: true
- `budgetUSD`: 0（关闭）

验证通过后再逐步加入 `bestOfNNotify`、预算等选项。

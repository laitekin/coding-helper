<div align="center">

# 🚀 qiniu-coding-helper

[![npm version](https://badge.fury.io/js/qiniu-coding-helper.svg)](https://www.npmjs.com/package/qiniu-coding-helper)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/node/v/qiniu-coding-helper.svg)](https://nodejs.org)

**一条命令，让本机所有 AI 编程助手接入七牛 AI 大模型推理服务**

支持 13 个编程助手 · 只改七牛自己的配置 · 随时一键还原

[English](README.en-US.md) · [能做什么](#-能做什么) · [快速开始](#-快速开始) · [支持的编程助手](#-支持的编程助手) · [命令一览](#-命令一览) · [安全机制](#-安全机制) · [常见问题](#-常见问题)

</div>

---

## 💡 能做什么

用七牛 API 驱动 Claude Code、Codex 等编程助手，原本要逐个打开它们的配置文件、查格式、手动填地址和 Key。Coding Helper 把这些事变成一条命令：

| 你想要 | 怎么做 |
|---|---|
| 把本机装好的编程助手全部接入七牛 | `npx qiniu-coding-helper setup`，勾选后一次写完，最后给出汇总表 |
| 不想动配置文件，只临时用七牛跑一次 | `npx qiniu-coding-helper run claude`，只对这次启动生效 |
| 先看看会改哪些文件 | `npx qiniu-coding-helper setup --dry-run`，逐文件展示差异，Key 打码，不写入 |
| 换了 Key 或线路 | 在菜单或 `auth` 里改一次，已接入的编程助手自动同步 |
| 看哪些编程助手已经接入 | `npx qiniu-coding-helper status` |
| 不用了，恢复原样 | `npx qiniu-coding-helper restore`，删掉七牛条目并写回原来的值 |
| 配好了却不生效 | `npx qiniu-coding-helper doctor`，检查 Key、账户余额状态、网络和环境变量覆盖 |
| 在脚本或 CI 里批量配置 | `setup --yes --json`，Key 用 `--key-stdin` 从标准输入读，退出码区分成功与失败 |

## 🚀 快速开始

无需安装，Node.js 18 以上直接运行：

```bash
npx qiniu-coding-helper
```

首次运行会进入 4 步向导：选择语言 → 选择线路（国内 / 海外）→ 输入 API Key（[获取地址](https://portal.qiniu.com/ai-inference/api-key)）→ 勾选要接入的编程助手（默认勾选已安装的）。每个编程助手选好模型后批量写入，最后显示每个工具的结果和原文件的备份位置。

之后再运行会进入主菜单，第一项「★ 一键配置编码工具」随时可以重新配置。

配置完成后**重启正在运行的编程助手**即可使用。

## 🧰 支持的编程助手

下表「实测」一列表示：在 Linux 上安装该版本的真实客户端，执行 `setup` 后完成了一次经七牛线路的真实问答，再执行 `restore` 确认配置还原。实测日期 2026-10-20。

| 编程助手 | 写入位置 | 实测 | 接入后怎么用 |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `env` | ✅ 2.x | `claude` |
| Codex | `~/.codex/config.toml`、`~/.codex/auth.json` | ✅ 0.163.0 | `codex` |
| OpenCode | `~/.config/opencode/opencode.json` | ✅ 1.19.3 | `opencode`（默认模型为 `qiniu/<模型>`） |
| Qwen Code | `~/.qwen/settings.json`，Key 单独写入 `~/.qwen/.env` | ✅ 0.25.3 | `qwen` |
| Kimi Code CLI | `~/.kimi-code/config.toml` | ✅ 2.2.0 | `kimi` |
| Factory Droid | `~/.factory/settings.json` 的 `customModels` | ✅ 0.245.0 | `droid`，在 `/model` 中选 `Qiniu: <模型>` |
| Grok CLI | `~/.grok/config.toml` | ✅ 1.0.62 | `grok`（默认模型指向七牛） |
| OpenClaw | `~/.openclaw/openclaw.json` | ✅ 2026.6.35 | `openclaw`（主模型为 `qiniu/<模型>`） |
| MiniMax Code | 调用官方 `mcode provider add` 写入 `~/.minimax/config.yaml` | ✅ 0.6.12 | `mcode` |
| GitHub Copilot CLI | 无配置文件，只注入环境变量 | ✅ 1.0.100 | `npx qiniu-coding-helper run copilot` |
| CodeBuddy | `~/.codebuddy/models.json` | ✅ 2.170.0 | `codebuddy`，用 `--model` 选七牛模型 |
| Hermes Agent | `~/.hermes/config.yaml` 的 `model` | ✅ 官方安装脚本 | `hermes` |
| WorkBuddy | `~/.workbuddy/models.json` | ⚠️ 未实测 | 桌面应用，手动启动 |

WorkBuddy 只有 Windows / macOS 桌面版，无法在 Linux 实测。它的配置格式与 CodeBuddy 相同（CodeBuddy 已实测），官方文档也说明 WorkBuddy 会读取 `~/.codebuddy/models.json`。

**模型怎么选：**

- **Claude Code：** 分别选择 Haiku / Sonnet / Opus / 子代理模型，不选则用 Claude Code 默认值。
- **Codex：** 固定使用七牛的 `openai/gpt-6-astra`，同时写入七牛 GPT 模型目录。
- **CodeBuddy / WorkBuddy：** 从七牛模型市场多选，能力标签和 token 上限自动填写。
- **Hermes Agent：** 从七牛模型市场选一个默认模型。
- **其余 8 个**（OpenCode、Qwen Code、Kimi、Droid、Grok、OpenClaw、MiniMax Code、Copilot CLI）：共用一个模型，第一次选好后，之后 `setup --yes` 直接复用；也可以在各自的菜单里单独选择。

**暂不支持 Gemini CLI：** 它只能使用 Gemini 原生协议（`/v1beta`），七牛线路目前还没有提供这个接口。

## 📚 命令一览

| 命令 | 作用 |
|---|---|
| `coding-helper` | 首次运行进入向导，之后进入主菜单 |
| `coding-helper setup` | 一键配置本机的编程助手 |
| `coding-helper status` | 读取各编程助手的实际配置，显示是否已接入七牛 |
| `coding-helper restore [工具]` | 移除七牛配置并还原原值 |
| `coding-helper run <工具> [参数...]` | 启动器：只给这次启动注入七牛设置 |
| `coding-helper doctor` | 健康检查 |
| `coding-helper auth [token]` | 设置 API Key；`auth revoke` 删除，`auth reload <工具>` 重新写入 |
| `coding-helper enter [工具]` | 进入主菜单或某个编程助手的菜单 |
| `coding-helper init` | 重新运行首次向导 |
| `coding-helper lang show` / `lang set zh_CN\|en_US` | 查看或切换界面语言 |

以下示例中的 `coding-helper` 都可以写成 `npx qiniu-coding-helper`。工具名支持别名，如 `claude`、`qwen`、`kimi`、`mcode`、`factory`。

### ⚡ setup：一键配置

```bash
# 交互式：勾选编程助手（默认勾选已安装的），选好模型后批量写入
coding-helper setup

# 非交互：配置所有已安装的编程助手（未安装的记为「跳过」）
coding-helper setup --yes

# 只配置指定的编程助手
coding-helper setup --tools claude,codex,opencode

# 先预览：逐文件展示将要改动的内容（Key 打码），不写入任何文件
coding-helper setup --dry-run

# 脚本 / CI：Key 从标准输入读取，不进 shell 历史；结果输出为 JSON
echo "$QINIU_KEY" | coding-helper setup --key-stdin --yes --json
```

| 参数 | 说明 |
|---|---|
| `--tools a,b` | 只配置指定的编程助手，即使没检测到安装也会写入 |
| `-y, --yes` | 跳过所有确认，使用已保存的模型 |
| `--dry-run` | 只预览变更，不写盘、不备份 |
| `--json` | 结果以 JSON 输出，便于脚本解析 |
| `--key-stdin` | 从标准输入读取 API Key 并校验 |

**退出码：** `0` 全部成功（未安装而跳过的不算失败），`2` 部分失败，`1` 全部失败。

写入前会先检查账户能否调用模型：如果 Key 有效但账户欠费暂停，会给出提醒，配置照常写入，充值后即可使用。

### 📋 status：查看接入状态

```bash
coding-helper status          # 表格：工具、安装版本、是否已接入七牛
coding-helper status --json   # JSON 输出
```

接入状态读取的是编程助手的实际配置文件，手动改过的情况也能如实反映。

### ↩️ restore：还原

```bash
coding-helper restore              # 还原所有已接入的编程助手
coding-helper restore codex,qwen   # 只还原指定的
coding-helper restore codex --yes  # 跳过确认
```

还原会删除七牛的条目，并把第一次写入前记录的原值写回：例如你原来的 `ANTHROPIC_BASE_URL`、Codex 的默认模型、`auth.json` 中的 OpenAI Key、Hermes 原来的模型与服务商。接入后你自己添加的其他配置不受影响。原本不存在、由 Coding Helper 创建的文件会被删除。

### 🚀 run：启动器模式

```bash
coding-helper run copilot                  # Copilot CLI 没有配置文件，只能这样使用
coding-helper run claude --continue        # 参数原样传给编程助手
coding-helper run claude -- --continue     # 也可以用 -- 分隔
```

只给这一次启动的进程注入七牛的环境变量，不修改任何配置文件，适合想同时保留官方账号的用户。退出码和 Ctrl+C 信号会透传。目前支持 Claude Code 与 GitHub Copilot CLI。

### 🏥 doctor：健康检查

```bash
coding-helper doctor
```

| 检查项 | 说明 |
|---|---|
| 配置文件 | `~/.coding-helper/config.yaml` 是否存在 |
| API Key | Key 是否有效 |
| 账户状态 | 能否真正调用模型；欠费暂停时 Key 校验仍会通过，这里会明确提示 |
| 网络连接 | 当前线路是否可达 |
| 各编程助手 | 安装版本，以及是否已接入七牛 |
| shell 环境变量覆盖 | 检测 `ANTHROPIC_BASE_URL` 等变量，它们会覆盖 Claude Code 的配置文件 |
| Node.js、Git | 版本 |

「账户状态」会发送一次只生成 1 个 token 的真实请求，正常账户会产生极少量费用。

### 🔄 修改 Key 或线路后自动同步

在主菜单、`auth <token>` 或向导里修改 API Key 或线路后，所有已接入七牛的编程助手会自动重新写入并显示同步结果，不需要再逐个执行 `auth reload`。如果某个编程助手已经被你手动切到其他服务商，会跳过它，不会强行改回来。

## 🔒 安全机制

Coding Helper 改的都是你日常使用的配置文件，所以每次写入都遵守以下规则：

- **只改七牛自己的条目。** 其他服务商、MCP 服务器、主题、沙箱策略等原样保留。TOML、`.env` 和 Hermes 的 YAML 按行编辑，注释、空行、顺序和引号风格都不变；JSON 沿用原文件的缩进与单行 / 多行风格。
- **写入前备份。** 每次运行把将要修改的原文件复制到 `~/.coding-helper/backups/<时间戳>/`，并生成 `manifest.json` 记录来源路径。
- **原子写入。** 先写临时文件再替换，中途失败不会留下半个文件；文件权限 0600，目录 0700。
- **配置文件损坏时不覆盖。** 如果你的 JSON / YAML 无法解析，会报错并保持原样，绝不会当作空配置写回。OpenClaw 的配置含注释或尾逗号（JSON5）时同样拒绝改写。
- **记录原值，可以还原。** 第一次写入前记录被覆盖键的原值（`~/.coding-helper/state.json`），`restore` 按此写回。重复配置不会把七牛的值误记成原值。
- **Key 不进命令行历史。** 推荐用交互输入或 `--key-stdin`；预览和日志中的 Key 都会打码。Qwen Code 的 Key 只写入 `.env`，设置文件里只引用变量名。
- **清除配置不影响还原。** 主菜单的「清除 Coding Helper 配置」只删除 `config.yaml`，备份和原值记录保留，之后仍可 `restore`。

实测中，在已有用户配置的情况下对 12 个编程助手执行 `setup` 两次再 `restore`，11 个原有配置文件全部逐字节还原。Hermes 官方 2333 行带注释的默认配置，写入时只改动 4 行。

## 🔧 配置说明

### 线路

| 线路 | 地址 | 适用 |
|---|---|---|
| 🇨🇳 国内线路 | `https://api.qnaigc.com` | 中国大陆用户 |
| 🌍 海外线路 | `https://api.modelink.ai` | 海外用户 |

### Coding Helper 自身的文件

| 路径 | 内容 |
|---|---|
| `~/.coding-helper/config.yaml` | 语言、线路、API Key、各编程助手的模型选择 |
| `~/.coding-helper/state.json` | 已接入的编程助手，以及被覆盖前的原值 |
| `~/.coding-helper/backups/<时间戳>/` | 每次写入前的原文件备份 |

### 各编程助手写入的内容

<details>
<summary><b>Claude Code</b></summary>

写入 `~/.claude/settings.json` 的 `env`，并在 `~/.claude.json` 标记已完成首次引导：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.qnaigc.com",
    "ANTHROPIC_AUTH_TOKEN": "<your-api-key>",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<所选模型>"
  },
  "companyAnnouncements": ["您正在使用七牛云 AI 大模型推理服务 🚀"],
  "attribution": { "commit": "", "pr": "" }
}
```

超时设为 50 分钟以适配长时间推理；关闭非必要流量和归属标注，以提高网关下的缓存命中率。shell 中的 `ANTHROPIC_BASE_URL` 等变量会覆盖这里的设置，`doctor` 会检测并提示。

</details>

<details>
<summary><b>Codex</b></summary>

在 `~/.codex/config.toml` 中原地更新顶层的 `model`、`model_provider`、`model_catalog_json`，并添加以下两张表；MCP 服务器、沙箱策略和其他 provider 原样保留：

```toml
[model_providers.qnaigc]
name = "Qiniu"
base_url = "https://api.qnaigc.com/bypass/openai/v1"
requires_openai_auth = true
wire_api = "responses"

[profiles.qn-gpt]
model_provider = "qnaigc"
model = "openai/gpt-6-astra"
```

API Key 写入 `~/.codex/auth.json`，七牛 GPT 模型目录写入 `~/.codex/model-catalogs/qnaigc.json`。还原时会写回原来的顶层键和 `auth.json` 中原有的 OpenAI Key。

</details>

<details>
<summary><b>OpenCode / Qwen Code / Kimi Code CLI / Factory Droid</b></summary>

均使用七牛的 OpenAI 兼容接口 `https://api.qnaigc.com/v1`：

- **OpenCode：** `provider.qiniu`（`@ai-sdk/openai-compatible`），并把 `model` 设为 `qiniu/<模型>`。
- **Qwen Code：** 在 `modelProviders.openai` 中加入七牛模型（`envKey: QINIU_API_KEY`），设置 `security.auth.selectedType` 与 `model.name`；Key 写入 `~/.qwen/.env`。
- **Kimi Code CLI：** `[providers.qiniu]`（`type = "openai"`）、`[models."qiniu/<模型>"]`，并设置 `default_model`。支持 `KIMI_CODE_HOME`。
- **Factory Droid：** 在 `customModels` 中加入 `displayName` 为 `Qiniu: <模型>` 的条目（`generic-chat-completion-api`），卸载时只删除这个前缀的条目。

上下文与输出上限从七牛模型市场读取，读取失败时使用保守的默认值。

</details>

<details>
<summary><b>Grok CLI / OpenClaw / MiniMax Code</b></summary>

- **Grok CLI：** 在 `~/.grok/config.toml` 写入 `[model.qiniu]`（`api_backend = "chat_completions"`），并把 `[models] default` 指向它。支持 `GROK_HOME`。
- **OpenClaw：** 在 `~/.openclaw/openclaw.json` 写入 `models.providers.qiniu`（`api: openai-completions`），设置 `agents.defaults.model.primary`；如果你配置了模型白名单，会把七牛模型加入白名单。
- **MiniMax Code：** 配置结构未公开，通过官方命令 `mcode provider add --use` 写入（会先做一次连通性测试，失败则什么都不保存）。还原时删除 `custom_provider.qiniu`，并写回原来的 `defaultModel`。

</details>

<details>
<summary><b>CodeBuddy / WorkBuddy / Hermes Agent</b></summary>

- **CodeBuddy / WorkBuddy：** 在 `models.json` 中加入 `vendor: "Qiniu"` 的模型条目（地址为完整的 `/v1/chat/completions`），并同步 `availableModels`；其他厂商的条目与字段保持不变。如果之前选过的模型被市场下架：部分下架会提示并只写入仍然存在的；全部下架则报错，文件保持不变。
- **Hermes Agent：** 只修改 `~/.hermes/config.yaml` 中 `model` 下的 `provider`、`default`、`base_url`、`api_key` 四行，其余内容和注释原样保留。

</details>

以上文件都以明文保存 API Key（Qwen Code 除外，它写在 `.env`），请当作密码文件对待。

## ❓ 常见问题

<details>
<summary><b>配置后编程助手没有走七牛</b></summary>

1. 运行 `coding-helper doctor`，看「shell 环境变量覆盖」一项。`ANTHROPIC_BASE_URL` 等变量会覆盖配置文件，请从 `~/.zshrc` / `~/.bashrc` 中删掉后重开终端。
2. 运行 `coding-helper status`，确认该编程助手显示「● 已接入七牛」；没有的话运行 `coding-helper setup --tools <工具>`。
3. 完全退出并重启该编程助手。

</details>

<details>
<summary><b>Key 有效，但调用时报错（如 403 / account_billing_suspended）</b></summary>

账户欠费暂停时，Key 校验仍会通过，但所有模型调用都会失败。运行 `coding-helper doctor`，「账户状态」会明确提示。到[七牛控制台](https://portal.qiniu.com/)充值后，恢复可能需要几分钟。

</details>

<details>
<summary><b>Codex 报模型不可用</b></summary>

Codex 固定使用 `openai/gpt-6-astra`。请确认你的账户可以使用 GPT 系列模型（可用 `coding-helper doctor` 检查账户状态，或在七牛控制台查看可用模型）。

</details>

<details>
<summary><b>Kimi 提示「检测到旧版 kimi-cli」</b></summary>

pip 安装的旧版 `kimi-cli`（1.x）读取的是 `~/.kimi`。请安装新版 Kimi Code：`npm install -g @moonshot-ai/kimi-code`。

</details>

<details>
<summary><b>OpenClaw 提示配置是 JSON5</b></summary>

`~/.openclaw/openclaw.json` 含注释或尾逗号时，为避免丢失注释，Coding Helper 不会改写它。删掉注释和尾逗号后重试即可。

</details>

<details>
<summary><b>MiniMax Code 配置失败</b></summary>

MiniMax Code 写入前会做连通性测试。请确认 Key 有效、账户未欠费，并且所选模型在你的账户中可用。

</details>

<details>
<summary><b>想撤销某次改动</b></summary>

优先用 `coding-helper restore`。需要回到某次写入前的完整原文件时，到 `~/.coding-helper/backups/<时间戳>/` 中找对应的备份，`manifest.json` 记录了每个备份的原路径。

</details>

<details>
<summary><b>支持 Gemini CLI 吗？</b></summary>

暂不支持。Gemini CLI 只能使用 Gemini 原生协议（`/v1beta`），七牛线路目前还没有提供这个接口。

</details>

---

## 🛠️ 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 编译 (tsc + 复制 locales 到 dist/)
pnpm test           # 编译并运行 node:test 测试（CI 在 Node 18 / 20 / 22 上运行）
pnpm dev            # 监听模式
pnpm start          # 运行 CLI (node dist/cli.js)
```

代码结构：

| 目录 | 职责 |
|---|---|
| `src/commands/` | 各子命令入口（setup、status、restore、run、auth、doctor、lang） |
| `src/lib/core/` | 核心层：安全写入与备份、原值记录、TOML / YAML / .env 按行编辑、装载与同步服务 |
| `src/lib/tools/` | 每个编程助手一个适配器；OpenAI 兼容的客户端继承 `OpenAICompatTool` |
| `src/lib/wizard/` | 交互向导、菜单与终端渲染 |

新增一个编程助手：在 `src/lib/tools/` 实现 `ITool`（OpenAI 兼容的继承 `OpenAICompatTool`），在 `tool-manager.ts` 注册，并在 `tests/` 加一组「写入 → 还原」的往返测试。

---

## 📄 License

本项目基于 [AGPL-3.0](LICENSE) 协议开源。

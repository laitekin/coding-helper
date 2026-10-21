# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Coding Helper — CLI 工具，把本机的 AI 编程助手一键接入七牛 API 端点。支持 13 个编程助手（Claude Code、Codex、OpenCode、Qwen Code、Kimi Code CLI、Factory Droid、Grok CLI、OpenClaw、MiniMax Code、GitHub Copilot CLI、CodeBuddy、WorkBuddy、Hermes Agent），提供交互式向导、非交互批量配置、还原与启动器模式，支持中英文。

用户通过 `npx qiniu-coding-helper` 直接运行，无需全局安装。

## Build & Run

```bash
pnpm install        # 安装依赖
pnpm build          # 编译 (tsc + 复制 locales 到 dist/)
pnpm dev            # 监听模式编译 (tsc --watch)
pnpm start          # 运行 CLI (node dist/cli.js)
pnpm clean          # 清理 dist/
```

构建后手动验证:
```bash
node dist/cli.js --version
node dist/cli.js --help
node dist/cli.js doctor
node dist/cli.js lang show
```

注意: `pnpm build` 包含 `cp -r src/locales dist/locales`，因为 tsc 不会复制 JSON 翻译文件。测试用 `pnpm test`（`node --test`，针对 dist/），CI 会运行。无 lint 配置。Node.js >= 18。

## Code Conventions

- 代码中注释使用中文
- 接口返回的响应体使用英文
- ESM 模块 (`"type": "module"`)，导入路径必须带 `.js` 后缀
- TypeScript strict 模式，target ES2022，module Node16

## Architecture

**入口链路**: `cli.ts` → `command.ts` (Commander 路由) → commands/ 或 wizard/

**核心单例**:
- `configManager` — 管理 `~/.coding-helper/config.yaml`，存储语言、线路、API Key、模型配置
- `i18n` — 国际化，从 `src/locales/*.json` 加载翻译，支持 `{{param}}` 模板替换，回退到 en_US
- `modelService` — 从 `/v1/models` 获取模型列表，带内存缓存；`marketModelService` 从 `/v1/market/models` 获取模型能力与上下文上限
- `toolManager` — 工具注册中心，注册全部 13 个编程助手适配器

**工具扩展**: 实现 `ITool` 接口 (`src/lib/tools/base-tool.ts`)，在 `ToolManager` 中注册即可。OpenAI 兼容的客户端（OpenCode、Qwen Code、Kimi Code CLI、Factory Droid、Grok CLI、OpenClaw、MiniMax Code、Copilot CLI）继承 `OpenAICompatTool`，共用 `toolModels` / `defaultModel` 模型配置；只支持环境变量的客户端设 `launchOnly` 并实现 `getLaunchEnv`。TOML / .env / YAML 用 `core/toml-edit.ts`、`core/dotenv-edit.ts`、`core/yaml-edit.ts` 按行编辑，保留注释与格式；JSON 用 `writeJson` 沿用原文件风格。CodeBuddy / WorkBuddy 共用 `tools/models-json.ts`。MiniMax Code 的配置结构未公开，写入走官方 `mcode provider add`。Gemini CLI 需要 Gemini 原生协议（/v1beta），七牛线路暂无，未接入。

**核心层** (`src/lib/core/`):
- `safe-write.ts` — 写客户端配置一律用 `safeWriteFile`（备份到 `~/.coding-helper/backups/<时间戳>/` + 原子写入；`setDryRun` 时只记录变更，供 `setup --dry-run`）；读用户 JSON 用 `readJsonObjectStrict`，解析失败抛错，绝不按空对象覆盖
- `state-store.ts` — `~/.coding-helper/state.json`，记录已装载的工具与首次写入前的原值（priors），卸载按原值还原
- `model-slots.ts` — 模型槽位（Claude 兜底/子代理、Codex 审查/子代理/记忆、Droid Spec、Grok 会话摘要、Hermes 看图）。`slotModels` 只记单独设置的槽位，其余跟随主模型；工具写配置时用 `slotModel(工具, 槽位, 主模型)` 取值
- `model-search.ts` — 模型搜索（规范化匹配、中文厂商名、`200k` / `看图` 过滤、相近建议、补厂商前缀），纯函数，有单测
- `quick-args.ts` / `model-mapping.ts` — 一条命令的参数解析、Key 来源、模型自动选择，以及一个模型到各工具配置项的映射（`commands/quick.ts` 串起流程）。工具可实现 `checkModel` 自行探测模型兼容性（Codex 探测七牛 Responses 接口，因为 GPT 模型不出现在 `/v1/models`）
- 测试可用 `CODING_HELPER_BASE_URL_CHINA` / `_INTERNATIONAL` 把线路指向本地模拟服务（见 `tests/quick-command.test.mjs`）
- `tool-service.ts` — `applyTool` / `removeTool` / `syncAppliedTools`，向导、`auth`、`setup`、`restore` 共用；改 Key 或线路后自动同步仍指向七牛的工具（`getSyncTargets`），`restore` 覆盖有装载记录或指向七牛的工具（`getRestoreTargets`）

**配置档与上下文**: `configManager` 的顶层 `api_key` / `endpoint` 始终是当前配置档（`profile`）的副本；`profiles` 存全部配置档，`tool_profiles` 记录单独绑定到其他配置档的工具。写工具配置一律经 `applyTool`，它用 `configManager.getConnection(tool.name)` 取该工具实际使用的 Key 与地址。`endpoint: custom` 时地址在 `base_url`，由 `registerCustomBaseUrls` 登记为七牛线路（用于识别、同步与还原）。`context_window` 为上下文上限，`capContextWindow` 按 min(设置, 模型上限) 用于各工具；Claude Code、Hermes、Copilot 不支持。Codex 的配置档写成 provider（`qnaigc-<名>`，`experimental_bearer_token`）+ `~/.codex/qn-<名>.config.toml`，不要再写 `[profiles.x]` 表（Codex 0.134+ 在 `--profile` 时会报错）

**向导系统** (`src/lib/wizard/`):
- 交互只用 ↑↓←→、回车、Esc（不要再加字母快捷键或在底部提示字母键）；每一步 Esc 回上一步：流程函数返回 `'back'` / `false` 表示回退
- `flows/` — 独立配置流程（语言、线路、API Key、选模型 `model-pick-flow`（`pickModel` 搜索页、`planForTool` / `buildModelPlan` 写入计划）、单个工具的模型槽位页 `model-slots-flow`、选工具 → 选模型 → 确认 `tool-setup-flow`（`toolsModelFlow`）、上下文 `context-flow`、配置档 `profile-flow`）
- `menus/` — 主菜单（6 项 + 账号与线路、更多…）、我的工具（`showToolSelector`）与工具页
- `ui/prompts.ts` — 基于 `@inquirer/core` 的 `menuPrompt`（右侧值、打字搜索 + `filter` 打分、`tabs` ←→ 切换、`arrows` 返回 left/right、`pinned` 只在无搜索时显示、`suggest` 无结果建议）、`checkPrompt`（回车勾选，首行全选、末行继续，Esc 返回 undefined）、`secretPrompt`（首尾 4 位掩码，`autoSubmit` 粘贴后自动提交，Esc 返回 undefined）
- `ui/write-plan.ts` — `confirmAndWrite` 确认页：每个工具一行，→ 展开，回车走 `edit` 调整，返回结果或 `'back'`
- `ui/pixel.ts` — 像素角色（12×10，键为工具名，`qiniu` 为小牛）与 QINIU Logo，`renderGrid` 用半块字符渲染；`pixelsSupported()` 为假时一律退回文字
- `ui/` — `uiRenderer` 统一终端渲染（页头 = Logo + 已接入工具角色 + 状态条）；界面层通过 `tool-registry.ts` 取工具列表，避免与 `tool-manager` 循环引用
- 界面截图：`docs/images/`（用 xterm.js 渲染真实终端输出生成）

**配置写入目标**:
- `~/.coding-helper/config.yaml` — coding-helper 自身配置（语言、线路、API Key、模型）
- `~/.coding-helper/state.json`、`backups/` — 装载记录、原值与原文件备份（清除配置时保留）
- `~/.claude/settings.json` — Claude Code 环境变量 (ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等)
- `~/.claude.json` — Claude Code onboarding 标记

## API Endpoints

- 国内线路: `https://api.qnaigc.com`
- 海外线路: `https://api.modelink.ai`
- 支持接口: `/v1/chat/completions`、`/v1/messages`、`/v1/models`
- API Key 校验: `/v2/stat/usage`（轻量级，验证 token 有效性；账户欠费暂停时仍返回 200）
- 账户可用性: `checkAccountStatus` 发一次 max_tokens=1 的真实请求（七牛先校验模型再校验计费，无法零成本探测）
- 认证: Bearer token

## CLI 命令

```bash
coding-helper <工具[,工具]|all> [sk-Key] [模型] [@配置档] [--intl] [--context 128k] [--dry-run] [--json] [--no-save]  # 一条命令配置
coding-helper                      # 默认：首次进向导，之后进主菜单（6 项，Esc 退出）
coding-helper init                 # 强制重新初始化
coding-helper setup [--tools a,b] [--yes] [--json] [--key-stdin] [--dry-run]  # 一键批量配置
coding-helper status [--json]      # 各工具实际接入状态
coding-helper restore [tools] [-y] # 移除七牛配置并还原原值
coding-helper run <tool> [@配置档] [args...] # 启动器：只给子进程注入环境变量（claude-code、copilot）
coding-helper profile [list|add|use|remove]  # 配置档；add <名> [sk-Key] [--intl|--base-url] [--use]，use <名> [工具]
coding-helper auth [token]         # 设置 API Key（交互式或直接传入）
coding-helper auth revoke          # 删除 API Key
coding-helper auth reload <tool>   # 重新加载配置到工具
coding-helper lang show|set <lang> # 语言管理 (zh_CN / en_US)
coding-helper doctor               # 健康检查
coding-helper enter [tool]         # 进入主菜单或工具配置菜单
```

## 命名约定

- 单例实例: camelCase (`configManager`, `modelService`, `toolManager`)
- 类: PascalCase (`ConfigManager`, `ClaudeCodeTool`)
- 接口: I 前缀 (`ITool`, `IToolManager`)
- 常量: UPPER_SNAKE_CASE (`VERSION`, `DEFAULT_ENDPOINT`)

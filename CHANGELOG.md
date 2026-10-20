# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 修复
* Claude Code 切换模型后仍在用旧模型：在 Claude Code 里用 `/model` 选过的模型保存在 `settings.json` 的 `model`，会盖过写入的模型槽位。现在切换模型时一并清掉它（以及 `ANTHROPIC_MODEL`），`/model` 回到「Default」并跟随主模型；同时写入旧版的 `ANTHROPIC_SMALL_FAST_MODEL`。确认页会列出「/model 当前选择 → Default」，`restore` 时写回原值
* Claude Code `/model` 列表里的 Fable 项指向 Opus 槽位的模型（`ANTHROPIC_DEFAULT_FABLE_MODEL`），七牛线路没有 Fable，之前选中会报错；各项说明改为「七牛 · 主模型 / 兜底模型 / Opus 槽位 / Fable 槽位」

## [0.6.2] - 2026-10-21

### 新增
* 配置档：一组 API Key + 线路（国内 / 海外 / 自定义地址）。`profile add / list / use / remove`，可切换当前配置档，或用 `profile use <名称> <工具>` 只让某个工具使用它；一条命令里用 `@名称` 指定，`run <工具> @名称` 只对这次启动生效
* Codex 多配置：每个配置档写一个自带 Key 的 provider 和 `~/.codex/qn-<名称>.config.toml`，可直接 `codex -p qn-<名称>` 切换（Codex 0.134+ 配置档格式，已用 codex-cli 0.163.0 实测）
* 上下文大小：`--context 128k` 或主菜单设置，各工具按「设置与模型上限的较小值」写入；Codex 写 `model_context_window` 并在还原时写回原值
* 自定义线路地址（私有化部署、代理网关）
* 像素风终端界面：像素 QINIU Logo、七牛小牛与 13 个编程助手的像素角色（半块字符 + 24 位真彩色），接入成功的工具角色亮起；不支持 256 色、终端过窄或设置 `NO_COLOR` 时退回文字界面
* 新菜单组件：右侧显示当前值、数字 / 字母快捷键、底部快捷键条、`/` 搜索；窄终端自动收起右侧列与换行
* 主菜单新增：切换模型、上下文大小、配置档、健康检查、还原配置
* 工具页按已安装 / 未安装分组，选中项显示模型、连接与配置路径，`m` 换模型、`s` 启动、`r` 还原、`a` 全部接入；工具详情页显示大号像素角色，`p` 绑定配置档
* 向导改为 5 步：语言 → 线路 → API Key → 工具 → 模型。Key 只显示首尾 4 位，逐条校验格式、Key、账户与可用模型，Key 属于另一条线路时自动切换；工具两列多选；所有工具统一选模型，Codex 等不兼容时自动改用自己的默认模型
* 结果页：接入成功的工具角色排成一排并打勾，结果表列出模型与启动命令，最后给出下一步与撤销方式

### 变更
* **只改用户选中的工具。** 切换模型、上下文大小、还原都先勾选目标工具（默认不勾选，`a` 全选）；改 API Key、线路或配置档后，列出仍在用旧设置的工具由用户勾选（不勾选 = 只保存）；一键配置 / 向导的工具多选也默认不勾选
* **写入前确认页。** 列出每个工具将改的内容（原值 → 新值）、会修改的文件和不会改动的工具；`d` 查看逐文件差异（预演，不写盘），`y` 写入，`esc` 取消
* Claude Code 切换模型时主模型（Sonnet · Opus）与兜底模型（Haiku · Subagent）一起切换，确认页分别列出
* 上下文大小按工具保存：只作用于选中的工具；`--context` 只作用于该命令里的工具
* 选模型不再改写「默认模型」，同步时不会让没选中的工具跟着换模型
* 命令行 `auth <key>`、`profile use <名>` 默认只保存；加 `--sync` 同步到已接入的工具，交互终端里会弹出勾选列表；删除配置档不再自动改写绑定它的工具
* 界面收敛：像素 Logo 只在主菜单出现，其他页面为一行品牌页头 + 状态行；结果页与工具详情不再显示像素角色，工具以品牌色小圆点标识；`CODING_HELPER_ART=0` 可完全关闭像素图

### 修复
* 检测已安装的编程助手不再依赖 `which`：会额外查找常见安装目录（`~/.local/bin`、`/opt/homebrew/bin` 等）和 Claude Code 本地安装位置（`~/.claude/local/claude`，这种安装只在 shell 里配了别名，子进程找不到，之前会显示「未安装」）；启动时也用找到的完整路径
* 还原 Codex 时，原本不存在的 `config.toml` 不再留下空文件

## [0.5.0] - 2026-10-20

### 新增
* 一条命令配置：`npx qiniu-coding-helper <工具[,工具…]|all> [API Key] [模型 ID]`，支持 `--intl`、`--dry-run`、`--json`、`--no-save`。Key 可来自参数、`QINIU_API_KEY`、已保存的 Key 或隐藏输入；模型可省略，自动从 Key 可用且支持工具调用的模型中选择；Key 无效时自动尝试另一条线路；Key、账户、模型校验全部在写入前完成；Codex 通过一次最小请求确认模型可在七牛 Responses 接口上使用
* 支持的编程助手从 5 个增加到 13 个：新增 OpenCode、Qwen Code、Kimi Code CLI、Factory Droid、Grok CLI、OpenClaw、MiniMax Code、GitHub Copilot CLI
* `setup`：一键配置本机的编程助手，支持 `--tools`、`--yes`、`--json`、`--key-stdin`、`--dry-run`，结果汇总表与退出码（0 / 2 / 1）
* `status`：读取各编程助手的实际配置文件，显示安装版本与是否已接入七牛
* `restore`：移除七牛配置并写回首次写入前的原值
* `run <tool>`：启动器模式，只给子进程注入七牛环境变量（Claude Code、Copilot CLI）
* 修改 API Key 或线路后，自动同步到仍指向七牛的编程助手
* `doctor` 新增账户状态（欠费暂停检测）、shell 环境变量覆盖检查与各工具接入状态
* 交互界面：首次向导欢迎卡片与 4 步进度、工具多选（默认勾选已安装）、主菜单「一键配置编码工具」、版本与接入状态徽标、写入进度与结果汇总表

### 修复
* Codex 不再整体覆盖 `config.toml`：只增删七牛条目，保留用户的 MCP、沙箱策略和其他 provider；卸载时还原原有的顶层键与 `auth.json` 中的 OpenAI Key
* Claude Code 卸载不再删除用户自己的 `companyAnnouncements`、`attribution`，并还原原有环境变量与 onboarding 标记
* Hermes Agent 写入不再删除 `config.yaml` 中的注释（官方默认配置 2052 行注释），并在卸载时还原原来的模型与服务商
* 用户配置文件损坏时报错，不再按空配置覆盖
* CodeBuddy / WorkBuddy 还原后保持原文件的字段顺序，不残留 `availableModels` 与空文件

### 变更
* 所有写入先备份到 `~/.coding-helper/backups/<时间戳>/` 并原子替换，不再生成 `.bak-fenno-*` 文件
* JSON 写入沿用原文件的缩进与单行 / 多行风格
* 「清除 Coding Helper 配置」只删除 `config.yaml`，保留备份与原值记录
* CI 运行 `node --test` 测试
* 新增依赖 `yaml`

## [0.4.0] - 2026-09-11

### 更新内容
* feat: 为 Codex 配置增加 GPT model-catalogs by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/37


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.7...v0.4.0

## [0.3.7] - 2026-07-13

### 更新内容
* refactor(endpoints): 精简为国内与海外两条线路 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/33


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.6...v0.3.7

## [0.3.6] - 2026-06-06

### 更新内容
* fix: 兼容低版本 Node 启动预检 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/31


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.5...v0.3.6

## [0.3.5] - 2026-06-01

### 更新内容
* ci: 添加 Codex PR 交互审阅流程 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/28
* feat: add Modelink endpoint by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/30


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.4...v0.3.5

## [0.3.4] - 2026-05-25

### 更新内容
* fix: 修复工具菜单版本查询失败后的重渲染循环 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/23
* feat: 优化工具首次配置引导 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/26
* refactor: 优化 Claude Code 配置结构 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/27


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.3...v0.3.4

## [0.3.3] - 2026-05-25

### 更新内容
* feat: add Hermes Agent support by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/22


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.2...v0.3.3

## [0.3.2] - 2026-05-23

### 更新内容
* feat(claude-code): 禁用属性块以提升网关 prompt cache 命中率 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/20


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.1...v0.3.2

## [0.3.1] - 2026-05-22

### 更新内容
* fix(cli): 启动期校验 Node 版本，提前提示升级 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/19


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.3.0...v0.3.1

## [0.3.0] - 2026-05-21

### 更新内容
* fix(codebuddy): 将 CodeBuddy/WorkBuddy 拆分为独立工具 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/15


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.2.1...v0.3.0

## [0.2.1] - 2026-05-20

### 更新内容
* docs(readme): 增加 CodeBuddy/WorkBuddy 集成说明 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/14


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.2.0...v0.2.1

## [0.2.0] - 2026-05-20

### 更新内容
* docs: 更新 README 工具配置说明 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/9
* docs: 添加 Issue 模板 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/13
* feat(codebuddy): 增加 CodeBuddy/WorkBuddy 工具配置支持 by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/12


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.1.4...v0.2.0

## [0.1.4] - 2026-05-20

### 更新内容
* chore: update release changelog automation by @krisxia0506 in https://github.com/qiniu/coding-helper/pull/7


**Full Changelog**: https://github.com/qiniu/coding-helper/compare/v0.1.3...v0.1.4

## [0.1.3] - 2026-05-20

### Fixed
- Codex 工具配置改为把 API Key 写入 Codex 的 `auth.json`

### Changed
- 简化 Codex provider 配置，移除不再需要的 token command 配置
- 更新 README 中 Codex 相关说明

## [0.1.2] - 2026-05-19

### Added
- 增加 Codex 工具配置支持
- 增加手动 npm 发版 workflow，支持版本更新、测试校验、GitHub Release 和 npm provenance 发布

### Changed
- 更新仓库链接为 `qiniu/coding-helper`
- 增加 `AGENTS.md` 项目指引入口

## [0.1.1] - 2026-03-11

### Added
- 初始化向导增加工具引导配置流程

### Fixed
- 修复配置面板表格右边框溢出问题
- 清除配置菜单项文案增加 Coding Helper 前缀
- API Key 重试输入前清屏并重新渲染界面

## [0.1.0] - 2026-03-10

### Added
- Interactive setup wizard for first-run configuration
- Multi-region support: China (api.qnaigc.com) and International (openai.sufy.com)
- API Key management: input, validation, save, and revoke
- Model configuration with API-fetched model list and manual input
- Claude Code integration: auto-writes environment variables to `~/.claude/settings.json`
- Health check via `doctor` command
- Internationalization: Chinese (zh_CN) and English (en_US)
- CLI commands: `init`, `auth`, `lang`, `doctor`, `enter`

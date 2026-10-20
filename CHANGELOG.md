# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 新增
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

import { findCommand, commandVersion } from '../../utils/find-command.js';
import path from 'node:path';
import os from 'node:os';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, safeWriteFile, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import { runModelSelectionFlow } from '../wizard/flows/model-selection-flow.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';

// API 超时时间：50 分钟，适配长时间推理请求
const API_TIMEOUT = '3000000';

// Claude Code 的环境变量 key 列表
const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // 旧版的快速模型变量；以及会覆盖 /model 选择的 ANTHROPIC_MODEL，统一由我们接管
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
];

// 用户在 Claude Code 里用 /model 选的模型（settings.json 的 model），没有时返回 undefined
export function claudeSelectedModel(): string | undefined {
  try {
    const settings = readJsonObjectStrict(CLAUDE_SETTINGS_FILE);
    return typeof settings.model === 'string' ? settings.model : undefined;
  } catch {
    return undefined;
  }
}

// Claude Code 配置文件路径
const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');
const CLAUDE_JSON_FILE = path.join(os.homedir(), '.claude.json');

// Claude Code 工具实现
export class ClaudeCodeTool implements ITool {
  name = 'claude-code';
  displayName = 'Claude Code';
  command = 'claude';
  installCommand = 'npm install -g @anthropic-ai/claude-code';
  updateCommand = 'claude update';
  npmPackageName = '@anthropic-ai/claude-code';
  aliases = ['claude'];

  // 获取已安装的 Claude Code 版本
  // 本地安装（claude migrate-installer）只在 shell 里配了别名，子进程的 PATH 里没有
  searchPaths = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'node_modules', '.bin', 'claude'),
  ];

  getVersion(): string | null {
    const file = findCommand(this.command, this.searchPaths);
    return file ? commandVersion(file) : null;
  }

  // 检查 claude 命令是否可用
  isInstalled(): boolean {
    return !!findCommand(this.command, this.searchPaths);
  }

  // 读取当前 Claude Code settings.json（解析失败时返回空对象，仅用于展示）
  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(CLAUDE_SETTINGS_FILE);
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    const env = this.getConfig().env;
    return isRecord(env) && isQiniuBaseUrl(env.ANTHROPIC_BASE_URL);
  }

  // 清除所有七牛相关配置，按记录的原值还原
  clearModelConfig(): void {
    const recorded = stateStore.getPriors(this.name);
    const settings = readJsonObjectStrict(CLAUDE_SETTINGS_FILE);
    const env = isRecord(settings.env) ? { ...settings.env } : {};
    // 没有装载记录且当前也不指向七牛：不是我们写的，不动用户配置
    if (!recorded && !isQiniuBaseUrl(env.ANTHROPIC_BASE_URL)) return;
    const priors = recorded ?? {};

    for (const key of CLAUDE_ENV_KEYS) {
      restoreValue(env, key, priors[`env.${key}`]);
    }
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;
    if ('settings.model' in priors) restoreValue(settings, 'model', priors['settings.model']);
    restoreValue(settings, 'companyAnnouncements', priors.companyAnnouncements);
    restoreValue(settings, 'attribution', priors.attribution);
    writeJsonOrRemove(CLAUDE_SETTINGS_FILE, settings);

    const onboardingKey = 'claudeJson.hasCompletedOnboarding';
    if (onboardingKey in priors) {
      const claudeJson = readJsonObjectStrict(CLAUDE_JSON_FILE);
      restoreValue(claudeJson, 'hasCompletedOnboarding', priors[onboardingKey]);
      writeJsonOrRemove(CLAUDE_JSON_FILE, claudeJson);
    }
  }

  // 将完整配置写入 Claude Code
  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    // 严格读取：文件损坏时直接报错，不覆盖用户配置
    const settings = readJsonObjectStrict(CLAUDE_SETTINGS_FILE);
    const claudeJson = readJsonObjectStrict(CLAUDE_JSON_FILE);
    const env = isRecord(settings.env) ? { ...settings.env } : {};

    this.recordPriors(settings, env, claudeJson);

    // 写入七牛配置；先清掉旧的模型变量，避免取消选择后残留
    for (const key of CLAUDE_ENV_KEYS) delete env[key];
    settings.env = { ...env, ...buildClaudeEnv(apiKey, baseUrl, models) };

    // 在 Claude Code 里用 /model 选过的模型保存在 settings.model，会盖过上面的模型槽位。
    // 切换模型时一并清掉，让 /model 回到「Default」并跟随主模型；原值记下，restore 时写回
    if (models.claudeCode && !models.claudeCode.useDefaultModels && models.claudeCode.sonnetModel) {
      if (!('settings.model' in (stateStore.getPriors(this.name) ?? {}))) {
        // 指向七牛模型（含 /）的值是接入后才选的，不当作原值
        const prior = typeof settings.model === 'string' && !settings.model.includes('/') ? settings.model : null;
        stateStore.recordPriors(this.name, { 'settings.model': prior });
      }
      delete settings.model;
    }

    // 写入公司公告（使用当前语言）
    settings.companyAnnouncements = [
      t('company_announcement'),
    ];

    // 禁用归属标注，通过代理端点运行时标注信息不准确
    settings.attribution = {
      commit: '',
      pr: '',
    };

    this.writeSettings(settings);

    // 写入 ~/.claude.json，设置 onboarding 完成标记
    claudeJson.hasCompletedOnboarding = true;
    writeJson(CLAUDE_JSON_FILE, claudeJson);
  }

  // 启动器模式：与写入 settings.json 的变量一致，只作用于本次启动
  getLaunchEnv(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string> {
    return buildClaudeEnv(apiKey, baseUrl, models);
  }

  // 从 Claude Code 移除配置
  unloadConfig(): void {
    this.clearModelConfig();
  }

  // 首次写入前记录原值；旧版本已写过七牛配置（无记录）时不把七牛的值当作原值
  private recordPriors(
    settings: Record<string, unknown>,
    env: Record<string, unknown>,
    claudeJson: Record<string, unknown>,
  ): void {
    if (stateStore.getPriors(this.name)) return;
    const legacy = isQiniuBaseUrl(env.ANTHROPIC_BASE_URL);
    const priors: PriorValues = {};
    for (const key of CLAUDE_ENV_KEYS) {
      priors[`env.${key}`] = legacy ? null : env[key] ?? null;
    }
    priors.companyAnnouncements = legacy ? null : settings.companyAnnouncements ?? null;
    priors.attribution = legacy ? null : settings.attribution ?? null;
    priors['claudeJson.hasCompletedOnboarding'] = claudeJson.hasCompletedOnboarding ?? null;
    stateStore.recordPriors(this.name, priors);
  }

  async runModelConfigFlow(): Promise<boolean> {
    return runModelSelectionFlow();
  }

  renderModelConfigSummary(): void {
    const claudeCode = configManager.getModels().claudeCode || {};
    uiRenderer.renderModelConfigItem(t('config_view_haiku'), claudeCode.haikuModel);
    uiRenderer.renderModelConfigItem(t('config_view_sonnet'), claudeCode.sonnetModel);
    uiRenderer.renderModelConfigItem(t('config_view_opus'), claudeCode.opusModel);
    uiRenderer.renderModelConfigItem(t('config_view_subagent'), claudeCode.subagentModel);
  }

  // 写入 settings.json（备份 + 原子写入）
  private writeSettings(settings: Record<string, unknown>): void {
    writeJson(CLAUDE_SETTINGS_FILE, settings);
  }
}

// 七牛线路下 Claude Code 需要的环境变量（settings.json 与启动器共用）
function buildClaudeEnv(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    API_TIMEOUT_MS: API_TIMEOUT,
    // 禁用非必要流量，第三方端点不需要 Anthropic 遥测
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // 禁用属性块，提升网关下 prompt cache 命中率
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
  const claudeCode = models.claudeCode || {};
  if (claudeCode.haikuModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = claudeCode.haikuModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = claudeCode.haikuModel;
  }
  if (claudeCode.sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = claudeCode.sonnetModel;
  if (claudeCode.opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = claudeCode.opusModel;
  if (claudeCode.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = claudeCode.subagentModel;
  return env;
}

// 原值为 null/undefined 时删除键，否则写回原值
function restoreValue(target: Record<string, unknown>, key: string, prior: unknown): void {
  if (prior === null || prior === undefined) delete target[key];
  else target[key] = prior;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

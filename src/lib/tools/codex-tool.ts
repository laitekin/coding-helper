import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { DEFAULT_ENDPOINT, getBaseUrl } from '../endpoints.js';
import { t } from '../i18n.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';
import { promptHelper } from '../wizard/ui/prompt-helper.js';
import { readJsonObjectStrict, safeWriteFile, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CONFIG_FILE = path.join(CODEX_DIR, 'config.toml');
const CODEX_AUTH_FILE = path.join(CODEX_DIR, 'auth.json');
const CODEX_CATALOG_DIR = path.join(CODEX_DIR, 'model-catalogs');
const CODEX_CATALOG_FILE = path.join(CODEX_CATALOG_DIR, 'qnaigc.json');
const PROVIDER_NAME = 'qnaigc';
const PROFILE_NAME = 'qn-gpt';
const CODEX_MODEL = 'openai/gpt-6-astra';
const DEFAULT_CODEX_BASE_URL = getBaseUrl(DEFAULT_ENDPOINT);

export interface CodexCatalogModel {
  id: string;
  context_length: number;
  max_tokens: number;
}

const GPT_MODELS: CodexCatalogModel[] = [
  ['openai/gpt-5-pro', 400000, 128000], ['openai/gpt-5.5', 1000000, 128000],
  ['openai/gpt-5.6-sol', 1050000, 128000], ['openai/gpt-5.6-terra', 1050000, 128000],
  ['openai/gpt-5.6-luna', 1050000, 128000], ['openai/gpt-6-astra', 1050000, 128000],
  ['openai/gpt-5.3-codex', 400000, 128000], ['openai/gpt-5-nano', 400000, 128000],
  ['openai/gpt-5.2-chat', 128000, 32000], ['openai/gpt-5-chat', 128000, 16400],
  ['openai/gpt-5-mini', 400000, 400000], ['openai/gpt-5', 400000, 128000],
  ['openai/gpt-5.2', 400000, 128000], ['openai/gpt-5.2-codex', 400000, 128000],
  ['openai/gpt-5.4-mini', 400000, 128000], ['openai/gpt-5.4-pro', 1000000, 128000],
  ['openai/gpt-5.4-nano', 400000, 128000], ['openai/gpt-5.4', 1050000, 128000],
].map(([id, context_length, max_tokens]) => ({ id: id as string, context_length: context_length as number, max_tokens: max_tokens as number }));

// Codex 工具实现
export class CodexTool implements ITool {
  name = 'codex';
  displayName = 'Codex';
  defaultModel = CODEX_MODEL;
  command = 'codex';
  installCommand = 'npm install -g @openai/codex';
  updateCommand = 'npm install -g @openai/codex@latest';
  npmPackageName = '@openai/codex';
  aliases = ['openai-codex'];

  getVersion(): string | null {
    try {
      const output = execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : output;
    } catch {
      return null;
    }
  }

  isInstalled(): boolean {
    try {
      const command = process.platform === 'win32' ? 'where codex' : 'which codex';
      execSync(command, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  getConfig(): Record<string, unknown> {
    const content = readCodexConfig();
    return {
      configPath: CODEX_CONFIG_FILE,
      authPath: CODEX_AUTH_FILE,
      configured: hasManagedCodexConfig(content),
    };
  }

  isConfigured(): boolean {
    return hasManagedCodexConfig(readCodexConfig());
  }

  clearModelConfig(): void {
    const content = readCodexConfig();
    safeWriteFile(CODEX_CONFIG_FILE, normalizeToml(removeTomlTable(content, 'profiles.qn-gpt')));
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const existingConfig = readCodexConfig();
    const existingAuth = readJsonObjectStrict(CODEX_AUTH_FILE);
    this.recordPriors(existingConfig, existingAuth);

    // 备份 + 原子写入；只增删七牛条目，用户的 MCP、沙箱策略、其他 provider 原样保留
    safeWriteFile(CODEX_AUTH_FILE, buildCodexAuthJson(JSON.stringify(existingAuth), apiKey));
    safeWriteFile(CODEX_CATALOG_FILE, buildCodexModelCatalog(GPT_MODELS));
    safeWriteFile(
      CODEX_CONFIG_FILE,
      mergeCodexConfig(existingConfig, baseUrl, models.codexModel || this.defaultModel, CODEX_CATALOG_FILE),
    );
  }

  async unloadConfig(): Promise<void> {
    const priors = stateStore.getPriors(this.name) ?? {};
    safeWriteFile(CODEX_CONFIG_FILE, restoreCodexConfig(readCodexConfig(), priors));
    if (fs.existsSync(CODEX_CATALOG_FILE)) fs.rmSync(CODEX_CATALOG_FILE);
    // 目录是我们创建的，清空后一并删除
    if (fs.existsSync(CODEX_CATALOG_DIR) && fs.readdirSync(CODEX_CATALOG_DIR).length === 0) {
      fs.rmdirSync(CODEX_CATALOG_DIR);
    }

    // 有记录时才还原 auth.json，避免误删用户自己的 OpenAI Key
    if ('auth.OPENAI_API_KEY' in priors) {
      const auth = readJsonObjectStrict(CODEX_AUTH_FILE);
      restoreJsonValue(auth, 'OPENAI_API_KEY', priors['auth.OPENAI_API_KEY']);
      restoreJsonValue(auth, 'auth_mode', priors['auth.auth_mode']);
      writeJsonOrRemove(CODEX_AUTH_FILE, auth);
    }
  }

  // 首次写入前记录被覆盖的顶层键与 auth.json 字段；旧版本已写过时不记录
  private recordPriors(config: string, auth: Record<string, unknown>): void {
    if (stateStore.getPriors(this.name) || hasManagedCodexConfig(config)) return;
    const priors: PriorValues = {};
    for (const key of MANAGED_TOP_LEVEL_KEYS) {
      priors[`config.${key}`] = getTopLevelTomlValue(config, key) ?? null;
    }
    priors['auth.OPENAI_API_KEY'] = auth.OPENAI_API_KEY ?? null;
    priors['auth.auth_mode'] = auth.auth_mode ?? null;
    stateStore.recordPriors(this.name, priors);
  }

  async runModelConfigFlow(): Promise<boolean> {
    uiRenderer.renderHeader();
    uiRenderer.renderHint(t('codex_fixed_model_hint', { model: this.defaultModel }));
    configManager.setModels({ codexModel: this.defaultModel });
    await promptHelper.pressEnter();
    return true;
  }

  renderModelConfigSummary(): void {
    uiRenderer.renderConfigItem(t('config_view_codex_model'), configManager.getModels().codexModel || this.defaultModel);
  }
}

export function buildCodexConfig(_existing: string, baseUrl?: string, model?: string, catalogPath?: string): string {
  const providerBaseUrl = `${(baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, '')}/bypass/openai/v1`;
  const sections = [
    ...(model ? [`model = "${escapeTomlString(model)}"`] : []),
    `model_provider = "${PROVIDER_NAME}"`,
    ...(catalogPath ? [`model_catalog_json = "${escapeTomlString(catalogPath)}"`] : []),
    '',
    `[model_providers.${PROVIDER_NAME}]`,
    'name = "Qiniu"',
    `base_url = "${escapeTomlString(providerBaseUrl)}"`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    '',
  ];

  if (model) {
    sections.push(
      `[profiles.${PROFILE_NAME}]`,
      `model_provider = "${PROVIDER_NAME}"`,
      `model = "${escapeTomlString(model)}"`,
      '',
    );
  }

  return normalizeToml(sections.join('\n'));
}

// 由七牛管理的顶层键（写入前记录原值，卸载时还原）
const MANAGED_TOP_LEVEL_KEYS = ['model', 'model_provider', 'model_catalog_json'] as const;

// 合并写入：原地更新顶层键（保持位置），替换七牛的 provider 与 profile 表，其他内容原样保留
export function mergeCodexConfig(existing: string, baseUrl?: string, model?: string, catalogPath?: string): string {
  let content = removeManagedTables(existing);
  if (model) content = upsertTopLevelTomlKey(content, 'model', `"${escapeTomlString(model)}"`);
  content = upsertTopLevelTomlKey(content, 'model_provider', `"${PROVIDER_NAME}"`);
  if (catalogPath) content = upsertTopLevelTomlKey(content, 'model_catalog_json', `"${escapeTomlString(catalogPath)}"`);

  const managed = buildCodexConfig('', baseUrl, model, catalogPath);
  const managedTables = managed.slice(managed.indexOf(`[model_providers.${PROVIDER_NAME}]`));
  const body = content.trim();
  return normalizeToml(body ? `${body}\n\n${managedTables}` : managedTables);
}

// 卸载：移除七牛的表，并把被覆盖的顶层键原地写回原值；无记录（旧版本写入）时按旧规则清理
export function restoreCodexConfig(existing: string, priors: PriorValues): string {
  const managed = hasManagedCodexConfig(existing);
  let content = existing;
  for (const key of MANAGED_TOP_LEVEL_KEYS) {
    const priorKey = `config.${key}`;
    if (priorKey in priors) {
      const prior = priors[priorKey];
      content = typeof prior === 'string'
        ? upsertTopLevelTomlKey(content, key, prior)
        : removeTopLevelTomlKey(content, key);
    }
  }
  if (!('config.model' in priors) && managed) content = removeTopLevelModel(content);
  if (!('config.model_provider' in priors)) content = removeTopLevelQnaigcModelProvider(content);
  if (!('config.model_catalog_json' in priors)) content = removeTopLevelCatalogPath(content);
  return normalizeToml(removeManagedTables(content));
}

function removeManagedTables(content: string): string {
  return removeTomlTable(
    removeTomlTable(content, `model_providers.${PROVIDER_NAME}`),
    `profiles.${PROFILE_NAME}`,
  );
}

export function removeManagedCodexConfig(existing: string): string {
  let content = existing;
  if (hasManagedCodexConfig(content)) content = removeTopLevelModel(content);
  content = removeTopLevelCatalogPath(content);
  content = removeTopLevelQnaigcModelProvider(content);
  content = removeTomlTable(content, `model_providers.${PROVIDER_NAME}`);
  content = removeTomlTable(content, `profiles.${PROFILE_NAME}`);
  return normalizeToml(content);
}

function removeTopLevelModel(content: string): string {
  const lines = content.split('\n');
  const searchEnd = topLevelEnd(lines);
  return lines.filter((line, lineIndex) => lineIndex >= searchEnd || !/^model\s*=/.test(line.trim())).join('\n');
}

function removeTopLevelCatalogPath(content: string): string {
  const lines = content.split('\n');
  return lines.filter((line) => !/^model_catalog_json\s*=\s*"[^"\n]*(?:\/|\\\\)model-catalogs(?:\/|\\\\)qnaigc\.json"\s*$/.test(line.trim())).join('\n');
}

export function buildCodexAuthJson(existing: string, apiKey: string): string {
  const auth = parseJsonObject(existing);
  auth.auth_mode = 'apikey';
  auth.OPENAI_API_KEY = apiKey;
  return `${JSON.stringify(auth, null, 2)}\n`;
}

export function buildCodexModelCatalog(models: CodexCatalogModel[]): string {
  const reasoningLevels = ['low', 'medium', 'high', 'xhigh'].map((effort) => ({
    effort,
    description: effort === 'low' ? 'Fast responses with lighter reasoning' :
      effort === 'medium' ? 'Balances speed and reasoning depth for everyday tasks' :
      effort === 'high' ? 'Greater reasoning depth for complex problems' :
      'Extra high reasoning depth for complex problems',
  }));
  return JSON.stringify({ models: models.filter((model) => model.id.startsWith('openai/gpt')).map((model, index) => ({
    slug: model.id,
    display_name: model.id.replace('openai/', '').replace(/(^|[-.])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`),
    description: `${model.id.replace('openai/', '')} coding model.`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: reasoningLevels,
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: index + 1,
    additional_speed_tiers: [],
    service_tiers: [],
    context_window: model.context_length,
    max_context_window: model.context_length,
    effective_context_window_percent: 95,
    input_modalities: ['text', 'image'],
    used_fallback_model_metadata: false,
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [],
    base_instructions: 'You are Codex, a coding agent based on GPT-5.',
  })) }) + '\n';
}

function readCodexConfig(): string {
  try {
    if (fs.existsSync(CODEX_CONFIG_FILE)) {
      return fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
    }
  } catch {
    // 文件不存在或读取失败时按空配置处理
  }
  return '';
}

function parseJsonObject(content: string): Record<string, unknown> {
  if (!content.trim()) return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

// 顶层区域：第一个表头之前的行
function topLevelEnd(lines: string[]): number {
  const index = lines.findIndex((line) => isTomlTableHeader(line));
  return index >= 0 ? index : lines.length;
}

function isTomlTableHeader(line: string): boolean {
  return /^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line.trim());
}

function topLevelKeyPattern(key: string): RegExp {
  return new RegExp(`^${key}\\s*=`);
}

// 读取顶层键的原始值文本（如 '"gpt-5"'），不存在时返回 undefined
export function getTopLevelTomlValue(content: string, key: string): string | undefined {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  for (let i = 0; i < end; i++) {
    const trimmed = lines[i].trim();
    if (topLevelKeyPattern(key).test(trimmed)) return trimmed.replace(topLevelKeyPattern(key), '').trim();
  }
  return undefined;
}

// 删除顶层键
export function removeTopLevelTomlKey(content: string, key: string): string {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  return lines.filter((line, i) => i >= end || !topLevelKeyPattern(key).test(line.trim())).join('\n');
}

// 更新或插入顶层键；新键插在顶层区域末尾（第一个表头之前）
export function upsertTopLevelTomlKey(content: string, key: string, rawValue: string): string {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  const line = `${key} = ${rawValue}`;
  const index = lines.findIndex((l, i) => i < end && topLevelKeyPattern(key).test(l.trim()));
  if (index >= 0) {
    lines[index] = line;
    return lines.join('\n');
  }
  let insertAt = end;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  // 紧挨着表头时补一个空行，保持可读
  if (insertAt + 1 < lines.length && isTomlTableHeader(lines[insertAt + 1])) {
    lines.splice(insertAt + 1, 0, '');
  }
  return lines.join('\n');
}

function removeTopLevelQnaigcModelProvider(content: string): string {
  const lines = content.split('\n');
  const searchEnd = topLevelEnd(lines);
  return lines
    .filter((line, lineIndex) => (
      lineIndex >= searchEnd ||
      !/^model_provider\s*=\s*"qnaigc"\s*$/.test(line.trim())
    ))
    .join('\n');
}

function removeTomlTable(content: string, tableName: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;
  const header = `[${tableName}]`;
  const dottedHeaderPrefix = `[${tableName}.`;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header || trimmed.startsWith(dottedHeaderPrefix)) {
      skipping = true;
      continue;
    }
    if (skipping && isTomlTableHeader(trimmed)) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  return result.join('\n');
}

function restoreJsonValue(target: Record<string, unknown>, key: string, prior: unknown): void {
  if (prior === null || prior === undefined) delete target[key];
  else target[key] = prior;
}

function hasManagedCodexConfig(content: string): boolean {
  return content.includes(`[model_providers.${PROVIDER_NAME}]`);
}

function normalizeToml(content: string): string {
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n` : '';
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

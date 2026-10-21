import { findCommand, commandVersion } from '../../utils/find-command.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { DEFAULT_ENDPOINT, getBaseUrl } from '../endpoints.js';
import { t } from '../i18n.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';
import { promptHelper } from '../wizard/ui/prompt-helper.js';
import { readJsonObjectStrict, safeWriteFile, writeJsonOrRemove, writeJson, writeTextOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  escapeTomlString,
  getTopLevelTomlValue,
  topLevelEnd,
  normalizeToml,
  removeTomlTable,
  removeTomlTablesWhere,
  removeTopLevelTomlKey,
  upsertTopLevelTomlKey,
  getTomlTableValue,
  upsertTomlTableKey,
  removeTomlTableKey,
} from '../core/toml-edit.js';
import { slotModel } from '../core/model-slots.js';

// 兼容旧导入路径
export { getTopLevelTomlValue, upsertTopLevelTomlKey, removeTopLevelTomlKey };

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
    const file = findCommand(this.command);
    return file ? commandVersion(file) : null;
  }

  isInstalled(): boolean {
    return !!findCommand(this.command);
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

  // Codex 走七牛的 OpenAI Responses 接口；GPT 模型不出现在 /v1/models 中，所以一律发一次最小的流式请求确认
  async checkModel(model: string, ctx: { apiKey: string; baseUrl: string }): Promise<string | undefined> {
    return await probeResponsesStream(ctx.baseUrl, ctx.apiKey, model) ? undefined : 'quick_codex_model_unsupported';
  }

  // 依据实测：GPT、qwen、glm、kimi 可用，deepseek 不可用；其他选定后再检测
  modelSupport(model: string): boolean | undefined {
    if (/deepseek/i.test(model)) return false;
    if (/gpt|qwen|glm|kimi/i.test(model)) return true;
    return undefined;
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
    writeJson(CODEX_AUTH_FILE, JSON.parse(buildCodexAuthJson(JSON.stringify(existingAuth), apiKey)));
    safeWriteFile(CODEX_CATALOG_FILE, buildCodexModelCatalog(GPT_MODELS));
    // 旧版本装载时没记录上下文原值，这里补记（已有记录时不覆盖）
    if (stateStore.getPriors(this.name)) {
      stateStore.recordPriors(this.name, { 'config.model_context_window': getTopLevelTomlValue(existingConfig, 'model_context_window') ?? null });
    }
    const model = models.codexModel || this.defaultModel;
    let content = mergeCodexConfig(existingConfig, baseUrl, model, CODEX_CATALOG_FILE);
    content = applyContextWindow(content, model, stateStore.getPriors(this.name) ?? {});
    // 代码审查、子代理、记忆整理默认是 OpenAI 的模型名，七牛上不可用，一律指向七牛模型（默认跟随主模型）
    stateStore.recordPriors(this.name, captureCodexSlotPriors(existingConfig));
    content = applyCodexSlots(content, {
      review: slotModel(this.name, 'review', model),
      subagent: slotModel(this.name, 'subagent', model),
      memory: slotModel(this.name, 'memory', model),
    });
    // 每个配置档写一个 provider + 配置档文件，之后可用 codex -p qn-<配置档> 直接切换
    const profiles = configManager.listProfiles();
    content = mergeCodexProfiles(content, profiles);
    safeWriteFile(CODEX_CONFIG_FILE, content);
    writeCodexProfileFiles(profiles, model, CODEX_CATALOG_FILE);
  }

  async unloadConfig(): Promise<void> {
    const priors = stateStore.getPriors(this.name) ?? {};
    // 还原后为空说明文件是我们创建的，直接删除
    writeTextOrRemove(CODEX_CONFIG_FILE, restoreCodexConfig(readCodexConfig(), priors));
    for (const file of managedProfileFiles()) writeTextOrRemove(file, '');
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

// 实测（2026-10）：GPT、qwen、glm、kimi 可在七牛 Responses 接口上驱动 Codex，deepseek 返回 502。
// 探测要求请求成功、每个流式事件都带 type，并以 response.completed / incomplete 结束，Codex 才能正常解析
export async function probeResponsesStream(baseUrl: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/bypass/openai/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'hi', max_output_tokens: 16, stream: true }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) return false;
    return isCodexCompatibleStream(await response.text());
  } catch {
    return false;
  }
}

export function isCodexCompatibleStream(body: string): boolean {
  const events = body.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== '[DONE]');
  if (events.length === 0) return false;
  let completed = false;
  for (const data of events) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return false;
    if (type === 'response.completed' || type === 'response.incomplete') completed = true;
  }
  return completed;
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
const MANAGED_TOP_LEVEL_KEYS = ['model', 'model_provider', 'model_catalog_json', 'model_context_window'] as const;

// 上下文大小：用户设置了就写 model_context_window（不超过模型上限），改回「自动」时还原原值
export function applyContextWindow(content: string, model: string, priors: PriorValues): string {
  const setting = configManager.getContextWindow('codex');
  if (setting) {
    const max = GPT_MODELS.find((m) => m.id === model)?.context_length;
    return upsertTopLevelTomlKey(content, 'model_context_window', String(max ? Math.min(setting, max) : setting));
  }
  const prior = priors['config.model_context_window'];
  if (prior === undefined) return content;
  return typeof prior === 'string'
    ? upsertTopLevelTomlKey(content, 'model_context_window', prior)
    : removeTopLevelTomlKey(content, 'model_context_window');
}

// 模型槽位对应的 Codex 配置项：[表名, 键名, 槽位]；表名为空表示顶层
export const CODEX_SLOT_KEYS: [string, string, 'review' | 'subagent' | 'memory'][] = [
  ['', 'review_model', 'review'],
  ['agents', 'default_subagent_model', 'subagent'],
  ['memories', 'extract_model', 'memory'],
  ['memories', 'consolidation_model', 'memory'],
];

function slotPriorKey(table: string, key: string): string {
  return `config.${table ? `${table}.` : ''}${key}`;
}

function getSlotValue(content: string, table: string, key: string): string | undefined {
  return table ? getTomlTableValue(content, table, key) : getTopLevelTomlValue(content, key);
}

function setSlotValue(content: string, table: string, key: string, raw: string | null): string {
  if (raw === null) return table ? removeTomlTableKey(content, table, key) : removeTopLevelTomlKey(content, key);
  return table ? upsertTomlTableKey(content, table, key, raw) : upsertTopLevelTomlKey(content, key, raw);
}

// 槽位原值（第一次写入前的值；之后 recordPriors 不会覆盖）
export function captureCodexSlotPriors(content: string): PriorValues {
  const priors: PriorValues = {};
  for (const [table, key] of CODEX_SLOT_KEYS) priors[slotPriorKey(table, key)] = getSlotValue(content, table, key) ?? null;
  return priors;
}

export function applyCodexSlots(content: string, models: Record<'review' | 'subagent' | 'memory', string>): string {
  let next = content;
  for (const [table, key, slot] of CODEX_SLOT_KEYS) next = setSlotValue(next, table, key, `"${escapeTomlString(models[slot])}"`);
  return normalizeToml(next);
}

// 还原槽位：有原值写回，没有则删除
export function restoreCodexSlots(content: string, priors: PriorValues): string {
  let next = content;
  for (const [table, key] of CODEX_SLOT_KEYS) {
    const priorKey = slotPriorKey(table, key);
    if (!(priorKey in priors)) continue;
    const prior = priors[priorKey];
    next = setSlotValue(next, table, key, typeof prior === 'string' ? prior : null);
  }
  return next;
}

// 配置档对应的 Codex 表名：provider qnaigc-<名>、profile qn-<名>
const PROFILE_PROVIDER_PREFIX = `${PROVIDER_NAME}-`;
const PROFILE_TABLE_PREFIX = 'qn-';

export function codexProfileName(profile: string): string {
  return `${PROFILE_TABLE_PREFIX}${profile.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function isProfileTable(name: string): boolean {
  return name.startsWith(`model_providers.${PROFILE_PROVIDER_PREFIX}`) ||
    (name.startsWith(`profiles.${PROFILE_TABLE_PREFIX}`) && name !== `profiles.${PROFILE_NAME}`);
}

// 配置档：config.toml 里每个配置档一个 provider（自带 Key，互不影响）；
// 模型与 provider 选择写进 ~/.codex/qn-<名>.config.toml（Codex 0.134+ 的配置档格式），用 codex -p qn-<名> 切换
export function mergeCodexProfiles(
  content: string,
  profiles: { name: string; apiKey: string; baseUrl: string }[],
): string {
  const body = removeTomlTablesWhere(content, isProfileTable).trim();
  const tables = profiles.map((p) => [
    `[model_providers.${codexProviderName(p.name)}]`,
    `name = "Qiniu (${escapeTomlString(p.name)})"`,
    `base_url = "${escapeTomlString(`${p.baseUrl.replace(/\/+$/, '')}/bypass/openai/v1`)}"`,
    `experimental_bearer_token = "${escapeTomlString(p.apiKey)}"`,
    'wire_api = "responses"',
    '',
  ].join('\n'));
  return normalizeToml(tables.length ? `${body}\n\n${tables.join('\n')}` : body);
}

export function codexProviderName(profile: string): string {
  return `${PROFILE_PROVIDER_PREFIX}${codexProfileName(profile).slice(PROFILE_TABLE_PREFIX.length)}`;
}

export function buildCodexProfileFile(profile: string, model: string, catalogPath?: string): string {
  return [
    '# 由 qiniu-coding-helper 生成：codex -p ' + codexProfileName(profile),
    `model_provider = "${codexProviderName(profile)}"`,
    `model = "${escapeTomlString(model)}"`,
    ...(catalogPath ? [`model_catalog_json = "${escapeTomlString(catalogPath)}"`] : []),
    '',
  ].join('\n');
}

function codexProfileFile(profile: string): string {
  return path.join(CODEX_DIR, `${codexProfileName(profile)}.config.toml`);
}

// 我们生成的配置档文件（qn-*.config.toml）
function managedProfileFiles(): string[] {
  try {
    return fs.readdirSync(CODEX_DIR)
      .filter((f) => f.startsWith(PROFILE_TABLE_PREFIX) && f.endsWith('.config.toml'))
      .map((f) => path.join(CODEX_DIR, f));
  } catch {
    return [];
  }
}

// 写入当前所有配置档的文件，删掉已不存在的配置档留下的文件
function writeCodexProfileFiles(profiles: { name: string }[], model: string, catalogPath: string): void {
  const wanted = new Map(profiles.map((p) => [codexProfileFile(p.name), buildCodexProfileFile(p.name, model, catalogPath)]));
  for (const file of managedProfileFiles()) {
    if (!wanted.has(file)) writeTextOrRemove(file, '');
  }
  for (const [file, text] of wanted) safeWriteFile(file, text);
}

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
  content = restoreCodexSlots(content, priors);
  return normalizeToml(removeManagedTables(content));
}

function removeManagedTables(content: string): string {
  return removeTomlTablesWhere(
    removeTomlTable(
      removeTomlTable(content, `model_providers.${PROVIDER_NAME}`),
      `profiles.${PROFILE_NAME}`,
    ),
    isProfileTable,
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


function restoreJsonValue(target: Record<string, unknown>, key: string, prior: unknown): void {
  if (prior === null || prior === undefined) delete target[key];
  else target[key] = prior;
}

function hasManagedCodexConfig(content: string): boolean {
  return content.includes(`[model_providers.${PROVIDER_NAME}]`);
}



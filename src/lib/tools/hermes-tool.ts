import { findCommand, commandVersion } from '../../utils/find-command.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { ConfigParseError, safeWriteFile, writeTextOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  getYamlValue,
  parseYamlDocument,
  removeYamlLine,
  restoreYamlValue,
  setYamlLine,
  setYamlPathLine,
  removeYamlPathLine,
  stringifyYamlDocument,
} from '../core/yaml-edit.js';
import { isMap } from 'yaml';
import { runHermesModelSelectionFlow } from '../wizard/flows/hermes-model-selection-flow.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';
import { promptHelper } from '../wizard/ui/prompt-helper.js';
import { slotOverrides } from '../core/model-slots.js';

const HERMES_DIR = path.join(os.homedir(), '.hermes');
const HERMES_CONFIG_FILE = path.join(HERMES_DIR, 'config.yaml');
const MANAGED_MODEL_KEYS = ['provider', 'default', 'base_url', 'api_key'] as const;
// 看图（视觉）辅助模型；Hermes 默认 auto = 跟随主模型，单独设置时才写入
const VISION_PATH = ['auxiliary', 'vision'];
const VISION_KEYS = ['provider', 'model', 'base_url', 'api_key'] as const;

// Hermes Agent 工具实现
export class HermesTool implements ITool {
  name = 'hermes';
  displayName = 'Hermes Agent';
  requiresModelSelection = true;
  command = 'hermes';
  installCommand = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
  updateCommand = 'hermes update';

  getVersion(): string | null {
    const file = findCommand(this.command);
    return file ? commandVersion(file) : null;
  }

  isInstalled(): boolean {
    return !!findCommand(this.command);
  }

  getConfig(): Record<string, unknown> {
    return parseYamlObject(readHermesConfig());
  }

  isConfigured(): boolean {
    const model = this.getConfig().model;
    return isRecord(model) && isQiniuBaseUrl(model.base_url);
  }

  clearModelConfig(): void {
    if (!stateStore.getPriors(this.name) && !this.isConfigured()) return;
    const priors = stateStore.getPriors(this.name);
    writeHermesConfig(applyHermesVision(removeManagedHermesConfig(readHermesConfig(), priors), undefined, priors ?? {}));
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    if (!models.hermesModel) {
      throw new Error(t('hermes_model_not_configured'));
    }
    const existing = readHermesConfig();
    // 严格校验：YAML 损坏时报错，不覆盖用户配置
    try {
      parseYamlDocument(existing);
    } catch (err) {
      throw new ConfigParseError(HERMES_CONFIG_FILE, err);
    }
    if (!stateStore.getPriors(this.name)) {
      const priors = captureHermesPriors(existing);
      if (priors) stateStore.recordPriors(this.name, priors);
    }
    stateStore.recordPriors(this.name, captureHermesVisionPriors(existing));
    const vision = slotOverrides(this.name, models).vision;
    const next = buildHermesConfig(existing, baseUrl, apiKey, models.hermesModel);
    writeHermesConfig(applyHermesVision(next, vision ? { model: vision, baseUrl, apiKey } : undefined, stateStore.getPriors(this.name) ?? {}));
  }

  async unloadConfig(): Promise<void> {
    this.clearModelConfig();
  }

  async runModelConfigFlow(): Promise<boolean> {
    const selected = await runHermesModelSelectionFlow();
    if (!selected) {
      return false;
    }
    configManager.setModels({ hermesModel: selected });
    uiRenderer.renderHeader();
    uiRenderer.renderSuccess(t('hermes_config_success', { model: selected }));
    await promptHelper.pressEnter();
    return true;
  }

  renderModelConfigSummary(): void {
    uiRenderer.renderModelConfigItem(t('config_view_hermes_model'), configManager.getModels().hermesModel);
  }
}

// 写入七牛的 model 配置：按行只改 provider / default / base_url / api_key，注释、空行与其他内容原样保留
export function buildHermesConfig(
  existing: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): string {
  const values: Record<(typeof MANAGED_MODEL_KEYS)[number], string> = {
    provider: 'custom',
    default: model,
    base_url: `${baseUrl.replace(/\/+$/, '')}/v1`,
    api_key: apiKey,
  };
  let next = existing;
  for (const key of MANAGED_MODEL_KEYS) next = setYamlLine(next, 'model', key, values[key]);
  return verifiedOrDocument(next, existing, values);
}

// 按行编辑后再解析一遍确认结果；结构特殊（如 model 写成流式映射）时退回文档级编辑
function verifiedOrDocument(next: string, existing: string, values: Partial<Record<string, string | null>>): string {
  try {
    const doc = parseYamlDocument(next);
    const ok = Object.entries(values).every(([key, value]) => (getYamlValue(doc, ['model', key]) ?? null) === value);
    if (ok) return next;
  } catch {
    // 落到下面的文档级编辑
  }
  const doc = parseYamlDocument(existing);
  if (!isMap(doc.get('model', true))) doc.set('model', doc.createNode({}));
  for (const [key, value] of Object.entries(values)) restoreYamlValue(doc, ['model', key], value);
  return stringifyYamlDocument(doc);
}

// 移除七牛的 model 配置；有原值记录时写回原值，否则删除这些键
export function removeManagedHermesConfig(existing: string, priors?: PriorValues): string {
  const values: Record<string, string | null> = {};
  let next = existing;
  for (const key of MANAGED_MODEL_KEYS) {
    const prior = priors ? priors[`model.${key}`] : null;
    values[key] = typeof prior === 'string' ? prior : null;
    next = typeof prior === 'string' ? setYamlLine(next, 'model', key, prior) : removeYamlLine(next, 'model', key);
  }
  return verifiedOrDocument(next, existing, values);
}

function visionIsOurs(doc: ReturnType<typeof parseYamlDocument>): boolean {
  return isQiniuBaseUrl(getYamlValue(doc, [...VISION_PATH, 'base_url']));
}

export function captureHermesVisionPriors(existing: string): PriorValues {
  const doc = parseYamlDocument(existing);
  if (visionIsOurs(doc)) return {};
  const priors: PriorValues = {};
  for (const key of VISION_KEYS) priors[`auxiliary.vision.${key}`] = getYamlValue(doc, [...VISION_PATH, key]) ?? null;
  return priors;
}

// 单独设置看图模型时写入 auxiliary.vision；跟随主模型时把我们写过的值还原。
// 优先按行编辑（只动这几行，注释与空格原样保留），结构特殊时退回文档级编辑
export function applyHermesVision(
  existing: string,
  vision: { model: string; baseUrl: string; apiKey: string } | undefined,
  priors: PriorValues,
): string {
  const doc = parseYamlDocument(existing);
  let values: Record<string, unknown>;
  if (vision) {
    values = { provider: 'custom', model: vision.model, base_url: `${vision.baseUrl.replace(/\/+$/, '')}/v1`, api_key: vision.apiKey };
  } else {
    if (!visionIsOurs(doc)) return existing;
    values = Object.fromEntries(VISION_KEYS.map((key) => [key, priors[`auxiliary.vision.${key}`] ?? null]));
  }
  const byLine = editVisionLines(existing, values);
  if (byLine !== undefined) {
    try {
      const check = parseYamlDocument(byLine);
      if (VISION_KEYS.every((key) => (getYamlValue(check, [...VISION_PATH, key]) ?? null) === (values[key] ?? null))) return byLine;
    } catch {
      // 落到下面的文档级编辑
    }
  }
  for (const key of VISION_KEYS) restoreYamlValue(doc, [...VISION_PATH, key], values[key] ?? null);
  return stringifyYamlDocument(doc);
}

function editVisionLines(content: string, values: Record<string, unknown>): string | undefined {
  let next: string | undefined = content;
  for (const key of VISION_KEYS) {
    const value = values[key];
    if (value === null || value === undefined) next = removeYamlPathLine(next, [...VISION_PATH, key]);
    else if (typeof value === 'string') next = setYamlPathLine(next, [...VISION_PATH, key], value);
    else return undefined;
    if (next === undefined) return undefined;
  }
  return next;
}

// 首次写入前的原值（旧版本写过七牛配置时不记录）
export function captureHermesPriors(existing: string): PriorValues | undefined {
  const doc = parseYamlDocument(existing);
  if (isQiniuBaseUrl(getYamlValue(doc, ['model', 'base_url']))) return undefined;
  const priors: PriorValues = {};
  for (const key of MANAGED_MODEL_KEYS) priors[`model.${key}`] = getYamlValue(doc, ['model', key]) ?? null;
  return priors;
}

function readHermesConfig(): string {
  try {
    if (fs.existsSync(HERMES_CONFIG_FILE)) {
      return fs.readFileSync(HERMES_CONFIG_FILE, 'utf-8');
    }
  } catch {
    // 文件不存在或读取失败时按空配置处理
  }
  return '';
}

function writeHermesConfig(content: string): void {
  // 还原后为空说明文件是我们创建的，直接删除
  if (!content.trim()) {
    writeTextOrRemove(HERMES_CONFIG_FILE, '');
    return;
  }
  safeWriteFile(HERMES_CONFIG_FILE, content);
  applyHermesConfigPermissions(HERMES_DIR, HERMES_CONFIG_FILE);
}

export function applyHermesConfigPermissions(configDir: string, configFile: string): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(configDir, 0o700);
  fs.chmodSync(configFile, 0o600);
}

function parseYamlObject(content: string): Record<string, unknown> {
  if (!content.trim()) return {};
  try {
    const parsed = yaml.load(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

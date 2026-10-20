import { findCommand, commandVersion } from '../../utils/find-command.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { ConfigParseError, safeWriteFile } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  getYamlValue,
  parseYamlDocument,
  removeYamlLine,
  restoreYamlValue,
  setYamlLine,
  stringifyYamlDocument,
} from '../core/yaml-edit.js';
import { isMap } from 'yaml';
import { runHermesModelSelectionFlow } from '../wizard/flows/hermes-model-selection-flow.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';
import { promptHelper } from '../wizard/ui/prompt-helper.js';

const HERMES_DIR = path.join(os.homedir(), '.hermes');
const HERMES_CONFIG_FILE = path.join(HERMES_DIR, 'config.yaml');
const MANAGED_MODEL_KEYS = ['provider', 'default', 'base_url', 'api_key'] as const;

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
    writeHermesConfig(removeManagedHermesConfig(readHermesConfig(), stateStore.getPriors(this.name)));
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
    writeHermesConfig(buildHermesConfig(existing, baseUrl, apiKey, models.hermesModel));
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

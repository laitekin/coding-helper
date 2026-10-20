import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { readTextFile, safeWriteFile, writeTextOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  escapeTomlString,
  getTopLevelTomlValue,
  normalizeToml,
  removeTomlTablesWhere,
  removeTopLevelTomlKey,
  upsertTopLevelTomlKey,
} from '../core/toml-edit.js';
import { OpenAICompatTool, fetchModelLimits, openAIBaseUrl } from './openai-compat-tool.js';

const PROVIDER_ID = 'qiniu';
const MODEL_ALIAS_PREFIX = `${PROVIDER_ID}/`;

export function getKimiConfigFile(): string {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'config.toml');
}

// 七牛的表：[providers.qiniu] 与 [models."qiniu/<model>"]
function isManagedTable(name: string): boolean {
  return name === `providers.${PROVIDER_ID}` ||
    name.startsWith(`providers.${PROVIDER_ID}.`) ||
    name.startsWith(`models."${MODEL_ALIAS_PREFIX}`);
}

export function hasManagedKimiConfig(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === `[providers.${PROVIDER_ID}]`);
}

// 写入七牛 provider 与模型别名，并设为 default_model；其他内容原样保留
export function applyKimiConfig(
  existing: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  contextWindow = 128000,
): string {
  const alias = `${MODEL_ALIAS_PREFIX}${model}`;
  let content = removeTomlTablesWhere(existing, isManagedTable);
  content = upsertTopLevelTomlKey(content, 'default_model', `"${escapeTomlString(alias)}"`);
  const tables = [
    `[providers.${PROVIDER_ID}]`,
    'type = "openai"',
    `base_url = "${escapeTomlString(openAIBaseUrl(baseUrl))}"`,
    `api_key = "${escapeTomlString(apiKey)}"`,
    '',
    `[models."${escapeTomlString(alias)}"]`,
    `provider = "${PROVIDER_ID}"`,
    `model = "${escapeTomlString(model)}"`,
    `max_context_size = ${contextWindow}`,
    '',
  ].join('\n');
  const body = content.trim();
  return normalizeToml(body ? `${body}\n\n${tables}` : tables);
}

// 移除七牛的表，按原值还原 default_model
export function revertKimiConfig(existing: string, priors: PriorValues): string {
  let content = existing;
  if ('config.default_model' in priors) {
    const prior = priors['config.default_model'];
    content = typeof prior === 'string'
      ? upsertTopLevelTomlKey(content, 'default_model', prior)
      : removeTopLevelTomlKey(content, 'default_model');
  } else if (getTopLevelTomlValue(content, 'default_model')?.startsWith(`"${MODEL_ALIAS_PREFIX}`)) {
    content = removeTopLevelTomlKey(content, 'default_model');
  }
  return normalizeToml(removeTomlTablesWhere(content, isManagedTable));
}

export class KimiCodeTool extends OpenAICompatTool {
  name = 'kimi-code';
  displayName = 'Kimi Code CLI';
  command = 'kimi';
  installCommand = 'npm install -g @moonshot-ai/kimi-code';
  updateCommand = 'npm install -g @moonshot-ai/kimi-code@latest';
  npmPackageName = '@moonshot-ai/kimi-code';
  aliases = ['kimi'];

  getConfig(): Record<string, unknown> {
    return { configPath: getKimiConfigFile(), configured: this.isConfigured() };
  }

  isConfigured(): boolean {
    return hasManagedKimiConfig(readTextFile(getKimiConfigFile()) ?? '');
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    // 旧版 kimi-cli（1.x，pip 安装）读的是 ~/.kimi，不认这里写的 ~/.kimi-code
    const version = this.getVersion();
    if (version && Number(version.split('.')[0]) < 2) {
      throw new Error(t('kimi_legacy_cli', { version, command: this.installCommand }));
    }
    const file = getKimiConfigFile();
    const existing = readTextFile(file) ?? '';
    if (!stateStore.getPriors(this.name) && !hasManagedKimiConfig(existing)) {
      stateStore.recordPriors(this.name, {
        'config.default_model': getTopLevelTomlValue(existing, 'default_model') ?? null,
      });
    }
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    safeWriteFile(file, applyKimiConfig(existing, baseUrl, apiKey, model, limits.contextWindow));
  }

  unloadConfig(): void {
    const file = getKimiConfigFile();
    if (!fs.existsSync(file)) return;
    const priors = stateStore.getPriors(this.name);
    if (!priors && !this.isConfigured()) return;
    writeTextOrRemove(file, revertKimiConfig(readTextFile(file) ?? '', priors ?? {}));
  }
}

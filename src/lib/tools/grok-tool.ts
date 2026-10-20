import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { readTextFile, safeWriteFile, writeTextOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  escapeTomlString,
  getTomlTableValue,
  normalizeToml,
  removeTomlTable,
  removeTomlTableKey,
  upsertTomlTableKey,
} from '../core/toml-edit.js';
import { OpenAICompatTool, fetchModelLimits, openAIBaseUrl } from './openai-compat-tool.js';

const MODEL_ID = 'qiniu';
const MODEL_TABLE = `model.${MODEL_ID}`;

export function getGrokConfigFile(): string {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'config.toml');
}

export function hasManagedGrokConfig(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === `[${MODEL_TABLE}]`);
}

// 写入 [model.qiniu] 自带模型（BYOK），并把 [models] default 指向它
export function applyGrokConfig(
  existing: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  contextWindow = 128000,
): string {
  let content = removeTomlTable(existing, MODEL_TABLE);
  content = upsertTomlTableKey(content, 'models', 'default', `"${MODEL_ID}"`);
  const table = [
    `[${MODEL_TABLE}]`,
    `model = "${escapeTomlString(model)}"`,
    `name = "Qiniu: ${escapeTomlString(model)}"`,
    `base_url = "${escapeTomlString(openAIBaseUrl(baseUrl))}"`,
    `api_key = "${escapeTomlString(apiKey)}"`,
    'api_backend = "chat_completions"',
    `context_window = ${contextWindow}`,
    '',
  ].join('\n');
  return normalizeToml(`${content.trim()}\n\n${table}`);
}

// 移除 [model.qiniu]，按原值还原 [models] default
export function revertGrokConfig(existing: string, priors: PriorValues): string {
  let content = removeTomlTable(existing, MODEL_TABLE);
  const prior = priors['models.default'];
  if (typeof prior === 'string') content = upsertTomlTableKey(content, 'models', 'default', prior);
  else if (getTomlTableValue(content, 'models', 'default') === `"${MODEL_ID}"`) {
    content = removeTomlTableKey(content, 'models', 'default');
  }
  return normalizeToml(content);
}

// xAI 官方 Grok CLI（grok build）
export class GrokTool extends OpenAICompatTool {
  name = 'grok';
  displayName = 'Grok CLI';
  command = 'grok';
  installCommand = 'curl -fsSL https://x.ai/cli/install.sh | bash';

  getConfig(): Record<string, unknown> {
    return { configPath: getGrokConfigFile(), configured: this.isConfigured() };
  }

  isConfigured(): boolean {
    return hasManagedGrokConfig(readTextFile(getGrokConfigFile()) ?? '');
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const file = getGrokConfigFile();
    const existing = readTextFile(file) ?? '';
    if (!stateStore.getPriors(this.name) && !hasManagedGrokConfig(existing)) {
      stateStore.recordPriors(this.name, {
        'models.default': getTomlTableValue(existing, 'models', 'default') ?? null,
      });
    }
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    safeWriteFile(file, applyGrokConfig(existing, baseUrl, apiKey, model, limits.contextWindow));
  }

  unloadConfig(): void {
    const file = getGrokConfigFile();
    if (!fs.existsSync(file)) return;
    const priors = stateStore.getPriors(this.name);
    if (!priors && !this.isConfigured()) return;
    writeTextOrRemove(file, revertGrokConfig(readTextFile(file) ?? '', priors ?? {}));
  }
}

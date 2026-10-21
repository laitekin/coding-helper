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
import { slotModel } from '../core/model-slots.js';

const MODEL_ID = 'qiniu';
const MODEL_TABLE = `model.${MODEL_ID}`;
// 会话摘要单独设置模型时的条目
const SUMMARY_ID = 'qiniu-summary';
const SUMMARY_TABLE = `model.${SUMMARY_ID}`;

export function getGrokConfigFile(): string {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'config.toml');
}

export function hasManagedGrokConfig(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === `[${MODEL_TABLE}]`);
}

// 由七牛管理的 [models] 键：会话默认模型与会话摘要（标题、摘要）模型
const MANAGED_MODELS_KEYS = ['default', 'session_summary'] as const;

function modelTable(table: string, model: string, baseUrl: string, apiKey: string, contextWindow: number): string {
  return [
    `[${table}]`,
    `model = "${escapeTomlString(model)}"`,
    `name = "Qiniu: ${escapeTomlString(model)}"`,
    `base_url = "${escapeTomlString(openAIBaseUrl(baseUrl))}"`,
    `api_key = "${escapeTomlString(apiKey)}"`,
    'api_backend = "chat_completions"',
    `context_window = ${contextWindow}`,
    '',
  ].join('\n');
}

// 写入 [model.qiniu] 自带模型（BYOK），并把 [models] default 指向它；
// 会话摘要默认也用它（Grok 默认用 xAI 的模型，自带 Key 时不可用），单独设置时多写一个 [model.qiniu-summary]
export function applyGrokConfig(
  existing: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  contextWindow = 128000,
  summary?: { model: string; contextWindow?: number },
): string {
  let content = removeTomlTable(removeTomlTable(existing, MODEL_TABLE), SUMMARY_TABLE);
  const separate = summary && summary.model !== model;
  content = upsertTomlTableKey(content, 'models', 'default', `"${MODEL_ID}"`);
  content = upsertTomlTableKey(content, 'models', 'session_summary', `"${separate ? SUMMARY_ID : MODEL_ID}"`);
  const tables = [
    modelTable(MODEL_TABLE, model, baseUrl, apiKey, contextWindow),
    ...(separate ? [modelTable(SUMMARY_TABLE, summary.model, baseUrl, apiKey, summary.contextWindow ?? contextWindow)] : []),
  ];
  return normalizeToml(`${content.trim()}\n\n${tables.join('\n')}`);
}

function isOurs(value: string | undefined): boolean {
  return value === `"${MODEL_ID}"` || value === `"${SUMMARY_ID}"`;
}

// 移除七牛的模型条目，按原值还原 [models] 下的键
export function revertGrokConfig(existing: string, priors: PriorValues): string {
  let content = removeTomlTable(removeTomlTable(existing, MODEL_TABLE), SUMMARY_TABLE);
  for (const key of MANAGED_MODELS_KEYS) {
    const prior = priors[`models.${key}`];
    if (typeof prior === 'string') content = upsertTomlTableKey(content, 'models', key, prior);
    else if (isOurs(getTomlTableValue(content, 'models', key))) content = removeTomlTableKey(content, 'models', key);
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
    // 只记第一次看到的原值；七牛自己写入的值不算原值
    const priors: PriorValues = {};
    for (const key of MANAGED_MODELS_KEYS) {
      const value = getTomlTableValue(existing, 'models', key);
      priors[`models.${key}`] = isOurs(value) ? null : value ?? null;
    }
    stateStore.recordPriors(this.name, priors);
    const limits = await fetchModelLimits(baseUrl, apiKey, model, this.name);
    const summary = slotModel(this.name, 'summary', model, models);
    const summaryLimits = summary === model ? limits : await fetchModelLimits(baseUrl, apiKey, summary, this.name);
    safeWriteFile(file, applyGrokConfig(existing, baseUrl, apiKey, model, limits.contextWindow, { model: summary, contextWindow: summaryLimits.contextWindow }));
  }

  unloadConfig(): void {
    const file = getGrokConfigFile();
    if (!fs.existsSync(file)) return;
    const priors = stateStore.getPriors(this.name);
    if (!priors && !this.isConfigured()) return;
    writeTextOrRemove(file, revertGrokConfig(readTextFile(file) ?? '', priors ?? {}));
  }
}

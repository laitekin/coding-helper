import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, readTextFile, formatJsonLike } from '../core/safe-write.js';
import { applyConfigEdits, restoreConfigEdits, parseConfigObject } from '../core/config-transaction.js';
import { OpenAICompatTool, fetchModelLimits, getPath, isRecord, openAIBaseUrl, setPath } from './openai-compat-tool.js';
import { escapeTomlString, normalizeToml, removeTomlTable, upsertTomlTableKey, validateToml } from '../core/toml-edit.js';
const MODEL_ID = 'qiniu';
const MODEL_TABLE = `model.${MODEL_ID}`;
// 会话摘要单独设置模型时的条目

export function getGrokConfigFile(): string {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'config.toml');
}

export function hasManagedGrokConfig(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === `[${MODEL_TABLE}]`);
}

// 由七牛管理的 [models] 键：会话默认模型与会话摘要（标题、摘要）模型

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
): string {
  let content = removeTomlTable(existing, MODEL_TABLE);
  content = upsertTomlTableKey(content, 'models', 'default', '"qiniu"');
  const next = normalizeToml(content.trimEnd() + '\n\n' + modelTable(MODEL_TABLE, model, baseUrl, apiKey, contextWindow));
  validateToml(next); return next;
}

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
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    applyConfigEdits(this.name, [{ file: getGrokConfigFile(), build: content => applyGrokConfig(content ?? '', baseUrl, apiKey, model, limits.contextWindow) }]);
  }
  unloadConfig(): void { restoreConfigEdits(this.name, [getGrokConfigFile()]); }
}

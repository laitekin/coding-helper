import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { readTextFile } from '../core/safe-write.js';
import { applyConfigEdits } from '../core/config-transaction.js';
import { OpenAICompatTool, fetchModelLimits, openAIBaseUrl } from './openai-compat-tool.js';
import { escapeTomlString, normalizeToml, removeTomlTable, upsertTomlTableKey, validateToml } from '../core/toml-edit.js';
const MODEL_ID = 'qiniu';
const MODEL_TABLE = `model.${MODEL_ID}`;

export function getGrokConfigFile(): string {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'config.toml');
}

export function hasManagedGrokConfig(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === `[${MODEL_TABLE}]`);
}


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
  unloadConfig(): void { this.restoreManagedConfig([getGrokConfigFile()]); }
}

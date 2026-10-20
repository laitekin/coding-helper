import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, safeWriteFile, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { OpenAICompatTool, fetchModelLimits, isRecord, openAIBaseUrl } from './openai-compat-tool.js';

// 七牛条目以此前缀命名，卸载时只删自己的
const DISPLAY_PREFIX = 'Qiniu: ';

function droidSettingsFile(): string {
  return path.join(os.homedir(), '.factory', 'settings.json');
}

function isQiniuModel(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return (typeof entry.displayName === 'string' && entry.displayName.startsWith(DISPLAY_PREFIX)) ||
    isQiniuBaseUrl(entry.baseUrl);
}

// 在 customModels 中替换七牛条目，其他自定义模型和设置原样保留
export function applyDroidSettings(
  settings: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: { contextWindow: number; maxOutputTokens: number },
): Record<string, unknown> {
  const existing = Array.isArray(settings.customModels) ? settings.customModels : [];
  return {
    ...settings,
    customModels: [
      ...existing.filter((entry) => !isQiniuModel(entry)),
      {
        model,
        displayName: `${DISPLAY_PREFIX}${model}`,
        baseUrl: openAIBaseUrl(baseUrl),
        apiKey,
        provider: 'generic-chat-completion-api',
        ...(limits ? { maxOutputTokens: limits.maxOutputTokens, maxContextLimit: limits.contextWindow } : {}),
      },
    ],
  };
}

export function revertDroidSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  if (!Array.isArray(next.customModels)) return next;
  const remaining = next.customModels.filter((entry) => !isQiniuModel(entry));
  if (remaining.length > 0) next.customModels = remaining;
  else delete next.customModels;
  return next;
}

export class DroidTool extends OpenAICompatTool {
  name = 'droid';
  displayName = 'Factory Droid';
  command = 'droid';
  installCommand = 'curl -fsSL https://app.factory.ai/cli | sh';
  aliases = ['factory'];

  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(droidSettingsFile());
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    const models = this.getConfig().customModels;
    return Array.isArray(models) && models.some(isQiniuModel);
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const settings = readJsonObjectStrict(droidSettingsFile());
    const limits = await fetchModelLimits(baseUrl, apiKey, model, this.name);
    writeJson(droidSettingsFile(), applyDroidSettings(settings, baseUrl, apiKey, model, limits));
  }

  unloadConfig(): void {
    if (!this.isConfigured()) return;
    writeJsonOrRemove(droidSettingsFile(), revertDroidSettings(readJsonObjectStrict(droidSettingsFile())));
  }
}

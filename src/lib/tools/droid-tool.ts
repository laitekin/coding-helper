import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { readJsonObjectStrict, formatJsonLike } from '../core/safe-write.js';
import { applyConfigEdits, parseConfigObject } from '../core/config-transaction.js';
import { OpenAICompatTool, fetchModelLimits, isRecord, openAIBaseUrl } from './openai-compat-tool.js';
const DISPLAY_PREFIX = 'Qiniu: ';
function droidSettingsFile(): string { return path.join(os.homedir(), '.factory', 'settings.json'); }
function isQiniuModel(entry: unknown): boolean { return isRecord(entry) && typeof entry.displayName === 'string' && entry.displayName.startsWith(DISPLAY_PREFIX); }
export function applyDroidSettings(settings: Record<string, unknown>, baseUrl: string, apiKey: string, model: string, limits?: { contextWindow: number; maxOutputTokens: number }): Record<string, unknown> {
  if (Object.hasOwn(settings, 'customModels') && (!Array.isArray(settings.customModels) || !settings.customModels.every(isRecord))) throw new Error('Invalid Droid customModels array.');
  const existing = Array.isArray(settings.customModels) ? settings.customModels : [];
  return { ...settings, customModels: [...existing.filter(entry => !isQiniuModel(entry)), {
    model, displayName: DISPLAY_PREFIX + model, baseUrl: openAIBaseUrl(baseUrl), apiKey, provider: 'generic-chat-completion-api',
    ...(limits ? { maxOutputTokens: limits.maxOutputTokens, maxContextLimit: limits.contextWindow } : {}),
  }] };
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
    const model = this.resolveModel(models); const limits = await fetchModelLimits(baseUrl, apiKey, model);
    applyConfigEdits(this.name, [{ file: droidSettingsFile(), build: content => formatJsonLike(content, applyDroidSettings(parseConfigObject(content), baseUrl, apiKey, model, limits)) }]);
  }
  unloadConfig(): void { this.restoreManagedConfig([droidSettingsFile()]); }
}

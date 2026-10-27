import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, readTextFile, formatJsonLike } from '../core/safe-write.js';
import { applyConfigEdits, restoreConfigEdits, parseConfigObject } from '../core/config-transaction.js';
import { OpenAICompatTool, fetchModelLimits, getPath, isRecord, openAIBaseUrl, setPath } from './openai-compat-tool.js';
import { setDotenvValue } from '../core/dotenv-edit.js';
// Key 只写进 ~/.qwen/.env，settings.json 里用 envKey 引用，不存明文
export const QWEN_ENV_KEY = 'QINIU_API_KEY';
const AUTH_TYPE = 'openai';
const MANAGED_PATHS = ['security.auth.selectedType', 'model.name'] as const;

function qwenDir(): string {
  return path.join(os.homedir(), '.qwen');
}

interface QwenModelEntry {
  id?: string;
  baseUrl?: string;
  envKey?: string;
  [key: string]: unknown;
}

function isQiniuEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return entry.envKey === QWEN_ENV_KEY || isQiniuBaseUrl(entry.baseUrl);
}

// 在 modelProviders.openai 中加入七牛模型并设为当前模型，其他条目原样保留
export function applyQwenSettings(
  settings: Record<string, unknown>,
  baseUrl: string,
  model: string,
  contextWindow?: number,
): Record<string, unknown> {
  for (const key of ['modelProviders', 'security', 'model']) {
    if (Object.hasOwn(settings, key) && !isRecord(settings[key])) throw new Error('Invalid Qwen configuration object: ' + key);
  }
  if (isRecord(settings.security) && Object.hasOwn(settings.security, 'auth') && !isRecord(settings.security.auth)) throw new Error('Invalid Qwen auth object.');
  if (isRecord(settings.modelProviders) && Object.hasOwn(settings.modelProviders, AUTH_TYPE) && !Array.isArray(settings.modelProviders[AUTH_TYPE])) throw new Error('Invalid Qwen providers array.');
  const next = structuredClone(settings);
  const providers = isRecord(next.modelProviders) ? next.modelProviders : {};
  const existing = Array.isArray(providers[AUTH_TYPE]) ? (providers[AUTH_TYPE] as QwenModelEntry[]) : [];
  if (existing.some(entry => !isRecord(entry))) throw new Error('Invalid Qwen provider entry.');
  if (existing.some(entry => !isQiniuEntry(entry) && entry.id === model)) throw new Error('Qwen model ID already belongs to another provider.');
  const entry: QwenModelEntry = {
    id: model,
    name: `Qiniu: ${model}`,
    baseUrl: openAIBaseUrl(baseUrl),
    envKey: QWEN_ENV_KEY,
    ...(contextWindow ? { generationConfig: { contextWindowSize: contextWindow } } : {}),
  };
  providers[AUTH_TYPE] = [...existing.filter((e) => !isQiniuEntry(e)), entry];
  next.modelProviders = providers;
  setPath(next, 'security.auth.selectedType', AUTH_TYPE);
  setPath(next, 'model.name', model);
  return next;
}

export class QwenCodeTool extends OpenAICompatTool {
  name = 'qwen-code';
  displayName = 'Qwen Code';
  command = 'qwen';
  installCommand = 'npm install -g @qwen-code/qwen-code';
  updateCommand = 'npm install -g @qwen-code/qwen-code@latest';
  npmPackageName = '@qwen-code/qwen-code';
  aliases = ['qwen'];

  private settingsFile(): string {
    return path.join(qwenDir(), 'settings.json');
  }

  private envFile(): string {
    return path.join(qwenDir(), '.env');
  }

  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(this.settingsFile());
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    const entries = getPath(this.getConfig(), `modelProviders.${AUTH_TYPE}`);
    return Array.isArray(entries) && entries.some(isQiniuEntry);
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    applyConfigEdits(this.name, [
      { file: this.settingsFile(), build: content => formatJsonLike(content, applyQwenSettings(parseConfigObject(content), baseUrl, model, limits.contextWindow)) },
      { file: this.envFile(), build: content => setDotenvValue(content ?? '', QWEN_ENV_KEY, apiKey) },
    ]);
  }
  unloadConfig(): void { restoreConfigEdits(this.name, [this.settingsFile(), this.envFile()]); }
}

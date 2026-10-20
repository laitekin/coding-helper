import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, readTextFile, safeWriteFile, writeJson, writeJsonOrRemove, writeTextOrRemove } from '../core/safe-write.js';
import { getDotenvValue, removeDotenvValue, setDotenvValue } from '../core/dotenv-edit.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  OpenAICompatTool,
  fetchModelLimits,
  getPath,
  isRecord,
  openAIBaseUrl,
  restorePath,
  setPath,
} from './openai-compat-tool.js';

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
  const next = structuredClone(settings);
  const providers = isRecord(next.modelProviders) ? next.modelProviders : {};
  const existing = Array.isArray(providers[AUTH_TYPE]) ? (providers[AUTH_TYPE] as QwenModelEntry[]) : [];
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

// 移除七牛模型条目，按原值还原认证方式与当前模型
export function revertQwenSettings(settings: Record<string, unknown>, priors: PriorValues): Record<string, unknown> {
  const next = structuredClone(settings);
  if (isRecord(next.modelProviders) && Array.isArray(next.modelProviders[AUTH_TYPE])) {
    const remaining = (next.modelProviders[AUTH_TYPE] as unknown[]).filter((e) => !isQiniuEntry(e));
    if (remaining.length > 0) next.modelProviders[AUTH_TYPE] = remaining;
    else restorePath(next, `modelProviders.${AUTH_TYPE}`, null);
  }
  for (const keyPath of MANAGED_PATHS) {
    if (keyPath in priors) restorePath(next, keyPath, priors[keyPath]);
  }
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
    const settings = readJsonObjectStrict(this.settingsFile());
    const env = readTextFile(this.envFile()) ?? '';

    if (!stateStore.getPriors(this.name)) {
      const legacy = this.isConfigured();
      const priors: PriorValues = {};
      for (const keyPath of MANAGED_PATHS) priors[keyPath] = legacy ? null : getPath(settings, keyPath) ?? null;
      priors[`env.${QWEN_ENV_KEY}`] = getDotenvValue(env, QWEN_ENV_KEY) ?? null;
      stateStore.recordPriors(this.name, priors);
    }

    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    safeWriteFile(this.envFile(), setDotenvValue(env, QWEN_ENV_KEY, apiKey));
    writeJson(this.settingsFile(), applyQwenSettings(settings, baseUrl, model, limits.contextWindow));
  }

  unloadConfig(): void {
    const priors = stateStore.getPriors(this.name);
    if (!priors && !this.isConfigured()) return;
    const settings = readJsonObjectStrict(this.settingsFile());
    writeJsonOrRemove(this.settingsFile(), revertQwenSettings(settings, priors ?? {}));

    const env = readTextFile(this.envFile());
    if (env !== undefined) {
      const prior = priors?.[`env.${QWEN_ENV_KEY}`];
      const next = typeof prior === 'string'
        ? setDotenvValue(env, QWEN_ENV_KEY, prior)
        : removeDotenvValue(env, QWEN_ENV_KEY);
      writeTextOrRemove(this.envFile(), next);
    }
  }
}

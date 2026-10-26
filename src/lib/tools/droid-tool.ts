import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, safeWriteFile, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import { slotModel } from '../core/model-slots.js';
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

// Droid 给自定义模型生成的 id：custom:<显示名，空白换成 -><同名序号>
export function droidCustomModelId(displayName: string, index = 0): string {
  return `custom:${displayName.trim().replace(/\s+/g, '-')}-${index}`;
}

// 由七牛管理的会话默认设置：主模型与 Spec 模式模型
const SESSION_KEYS = ['model', 'specModeModel'] as const;

type Limits = { contextWindow: number; maxOutputTokens: number };

// 在 customModels 中替换七牛条目，并把会话默认模型指向它；其他自定义模型和设置原样保留。
// specModel 与主模型不同时多写一个条目
export function applyDroidSettings(
  settings: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: Limits,
  specModel: string = model,
  specLimits?: Limits,
): Record<string, unknown> {
  const existing = Array.isArray(settings.customModels) ? settings.customModels : [];
  const entry = (id: string, l?: Limits) => ({
    model: id,
    displayName: `${DISPLAY_PREFIX}${id}`,
    baseUrl: openAIBaseUrl(baseUrl),
    apiKey,
    provider: 'generic-chat-completion-api',
    ...(l ? { maxOutputTokens: l.maxOutputTokens, maxContextLimit: l.contextWindow } : {}),
  });
  const ours = [entry(model, limits), ...(specModel !== model ? [entry(specModel, specLimits)] : [])];
  const session = isRecord(settings.sessionDefaultSettings) ? settings.sessionDefaultSettings : {};
  return {
    ...settings,
    customModels: [...existing.filter((e) => !isQiniuModel(e)), ...ours],
    sessionDefaultSettings: {
      ...session,
      model: droidCustomModelId(`${DISPLAY_PREFIX}${model}`),
      specModeModel: droidCustomModelId(`${DISPLAY_PREFIX}${specModel}`),
    },
  };
}

// 七牛写入的会话默认值（custom:Qiniu:-…）
function isQiniuSessionModel(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`custom:${DISPLAY_PREFIX.trim()}-`);
}

// 移除七牛条目；会话默认值有原值时写回，没有原值且仍指向七牛时删除
export function revertDroidSettings(settings: Record<string, unknown>, priors: PriorValues = {}): Record<string, unknown> {
  const next = { ...settings };
  if (Array.isArray(next.customModels)) {
    const remaining = next.customModels.filter((entry) => !isQiniuModel(entry));
    if (remaining.length > 0) next.customModels = remaining;
    else delete next.customModels;
  }
  if (isRecord(next.sessionDefaultSettings)) {
    const session = { ...next.sessionDefaultSettings };
    for (const key of SESSION_KEYS) {
      const prior = priors[`sessionDefaultSettings.${key}`];
      if (typeof prior === 'string') session[key] = prior;
      else if (isQiniuSessionModel(session[key])) delete session[key];
    }
    if (Object.keys(session).length) next.sessionDefaultSettings = session;
    else delete next.sessionDefaultSettings;
  }
  return next;
}

export function captureDroidPriors(settings: Record<string, unknown>): PriorValues {
  const session = isRecord(settings.sessionDefaultSettings) ? settings.sessionDefaultSettings : {};
  const priors: PriorValues = {};
  for (const key of SESSION_KEYS) {
    const value = session[key];
    priors[`sessionDefaultSettings.${key}`] = typeof value === 'string' && !isQiniuSessionModel(value) ? value : null;
  }
  return priors;
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
    const spec = slotModel(this.name, 'spec', model, models);
    const settings = readJsonObjectStrict(droidSettingsFile());
    stateStore.recordPriors(this.name, captureDroidPriors(settings));
    const limits = await fetchModelLimits(baseUrl, apiKey, model, this.name);
    const specLimits = spec === model ? limits : await fetchModelLimits(baseUrl, apiKey, spec, this.name);
    writeJson(droidSettingsFile(), applyDroidSettings(settings, baseUrl, apiKey, model, limits, spec, specLimits));
  }

  unloadConfig(): void {
    if (!this.isConfigured()) return;
    const priors = stateStore.getPriors(this.name) ?? {};
    writeJsonOrRemove(droidSettingsFile(), revertDroidSettings(readJsonObjectStrict(droidSettingsFile()), priors));
  }
}

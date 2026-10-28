import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, formatJsonLike } from '../core/safe-write.js';
import { applyConfigEdits, parseConfigObject } from '../core/config-transaction.js';
import { OpenAICompatTool, fetchModelLimits, getPath, isRecord, openAIBaseUrl, setPath } from './openai-compat-tool.js';
const PROVIDER_ID = 'qiniu';
const PRIMARY_PATH = 'agents.defaults.model.primary';

export function getOpenClawConfigFile(): string {
  const userHome = os.homedir();
  const expand = (value: string, home: string): string => path.resolve(value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? path.join(home, value.slice(2)) : value);
  const home = expand(process.env.OPENCLAW_HOME?.trim() || userHome, userHome);
  const resolve = (value: string): string => expand(value, home);
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return resolve(explicit);
  const state = process.env.OPENCLAW_STATE_DIR?.trim();
  if (state) return path.join(resolve(state), 'openclaw.json');
  if (process.env.OPENCLAW_PROFILE?.trim()) throw new Error('Set OPENCLAW_CONFIG_PATH or OPENCLAW_STATE_DIR for a named OpenClaw profile.');
  return path.join(resolve(home), '.openclaw', 'openclaw.json');
}

// 写入 models.providers.qiniu 并设为主模型；已有模型白名单时把七牛模型加入白名单
export function applyOpenClawConfig(
  config: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: { contextWindow: number; maxOutputTokens: number },
): Record<string, unknown> {
  for (const key of ['models', 'models.providers', 'agents', 'agents.defaults', 'agents.defaults.model', 'agents.defaults.models']) {
    const value = getPath(config, key);
    if (value !== undefined && !isRecord(value)) throw new Error('Invalid OpenClaw object: ' + key);
  }
  const next = structuredClone(config);
  const ref = `${PROVIDER_ID}/${model}`;
  setPath(next, `models.providers.${PROVIDER_ID}`, {
    baseUrl: openAIBaseUrl(baseUrl),
    apiKey,
    api: 'openai-completions',
    models: [{
      id: model,
      name: `Qiniu: ${model}`,
      ...(limits ? { contextWindow: limits.contextWindow, maxTokens: limits.maxOutputTokens } : {}),
    }],
  });
  setPath(next, PRIMARY_PATH, ref);
  const allow = getPath(next, 'agents.defaults.models');
  if (isRecord(allow)) {
    for (const key of Object.keys(allow)) if (key.startsWith(`${PROVIDER_ID}/`)) delete allow[key];
    allow[ref] = {};
  }
  return next;
}

export class OpenClawTool extends OpenAICompatTool {
  name = 'openclaw';
  displayName = 'OpenClaw';
  command = 'openclaw';
  installCommand = 'npm install -g openclaw';
  updateCommand = 'npm install -g openclaw@latest';
  npmPackageName = 'openclaw';

  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(getOpenClawConfigFile());
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    return isQiniuBaseUrl(getPath(this.getConfig(), `models.providers.${PROVIDER_ID}.baseUrl`));
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models); const limits = await fetchModelLimits(baseUrl, apiKey, model);
    applyConfigEdits(this.name, [{ file: getOpenClawConfigFile(), build: content => {
      let config: Record<string, unknown>;
      try { config = parseConfigObject(content); }
      catch { throw new Error(t('openclaw_json5_unsupported', { file: getOpenClawConfigFile() })); }
      return formatJsonLike(content, applyOpenClawConfig(config, baseUrl, apiKey, model, limits));
    } }]);
  }
  unloadConfig(): void { this.restoreManagedConfig([getOpenClawConfigFile()]); }
}

import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { ConfigParseError, readJsonObjectStrict, safeWriteFile, writeJsonOrRemove } from '../core/safe-write.js';
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

const PROVIDER_ID = 'qiniu';
const PRIMARY_PATH = 'agents.defaults.model.primary';

export function getOpenClawConfigFile(): string {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

// 写入 models.providers.qiniu 并设为主模型；已有模型白名单时把七牛模型加入白名单
export function applyOpenClawConfig(
  config: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: { contextWindow: number; maxOutputTokens: number },
): Record<string, unknown> {
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

// 移除七牛 provider 与白名单条目，按原值还原主模型
export function revertOpenClawConfig(config: Record<string, unknown>, priors: PriorValues): Record<string, unknown> {
  const next = structuredClone(config);
  restorePath(next, `models.providers.${PROVIDER_ID}`, null);
  const allow = getPath(next, 'agents.defaults.models');
  if (isRecord(allow)) {
    for (const key of Object.keys(allow)) if (key.startsWith(`${PROVIDER_ID}/`)) delete allow[key];
  }
  if (PRIMARY_PATH in priors) restorePath(next, PRIMARY_PATH, priors[PRIMARY_PATH]);
  else if (String(getPath(next, PRIMARY_PATH) ?? '').startsWith(`${PROVIDER_ID}/`)) restorePath(next, PRIMARY_PATH, null);
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

  // openclaw.json 是 JSON5：含注释或尾逗号时无法无损改写，给出明确提示而不是覆盖
  private readConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(getOpenClawConfigFile());
    } catch (err) {
      if (err instanceof ConfigParseError) {
        throw new Error(t('openclaw_json5_unsupported', { file: getOpenClawConfigFile() }));
      }
      throw err;
    }
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const config = this.readConfig();
    if (!stateStore.getPriors(this.name)) {
      const legacy = isQiniuBaseUrl(getPath(config, `models.providers.${PROVIDER_ID}.baseUrl`));
      stateStore.recordPriors(this.name, { [PRIMARY_PATH]: legacy ? null : getPath(config, PRIMARY_PATH) ?? null });
    }
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    safeWriteFile(getOpenClawConfigFile(), JSON.stringify(applyOpenClawConfig(config, baseUrl, apiKey, model, limits), null, 2) + '\n');
  }

  unloadConfig(): void {
    const priors = stateStore.getPriors(this.name);
    if (!priors && !this.isConfigured()) return;
    writeJsonOrRemove(getOpenClawConfigFile(), revertOpenClawConfig(this.readConfig(), priors ?? {}));
  }
}

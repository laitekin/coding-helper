import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { readJsonObjectStrict, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  OpenAICompatTool,
  fetchModelLimits,
  getPath,
  isRecord,
  openAIBaseUrl,
  restorePath,
} from './openai-compat-tool.js';

const PROVIDER_ID = 'qiniu';

// OpenCode 全局配置：优先 opencode.json，只有 opencode.jsonc 时使用它（含注释时会解析失败并报错，不覆盖）
export function getOpenCodeConfigFile(home = os.homedir()): string {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  return !fs.existsSync(json) && fs.existsSync(jsonc) ? jsonc : json;
}

// 写入七牛 provider 并设为默认模型，其他 provider 与设置原样保留
export function applyOpenCodeConfig(
  config: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: { contextWindow: number; maxOutputTokens: number },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  if (!next.$schema) next.$schema = 'https://opencode.ai/config.json';
  const providers = isRecord(next.provider) ? { ...next.provider } : {};
  providers[PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Qiniu',
    options: { baseURL: openAIBaseUrl(baseUrl), apiKey },
    models: {
      [model]: {
        name: model,
        ...(limits ? { limit: { context: limits.contextWindow, output: limits.maxOutputTokens } } : {}),
      },
    },
  };
  next.provider = providers;
  next.model = `${PROVIDER_ID}/${model}`;
  return next;
}

// 移除七牛 provider，按原值还原默认模型
export function revertOpenCodeConfig(config: Record<string, unknown>, priors: PriorValues): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  if (isRecord(next.provider)) next.provider = { ...next.provider };
  restorePath(next, `provider.${PROVIDER_ID}`, null);
  if ('model' in priors) restorePath(next, 'model', priors.model);
  else if (typeof next.model === 'string' && next.model.startsWith(`${PROVIDER_ID}/`)) delete next.model;
  // $schema 是我们补的，一并移除
  if (priors.$schema === null) delete next.$schema;
  return next;
}

export class OpenCodeTool extends OpenAICompatTool {
  name = 'opencode';
  displayName = 'OpenCode';
  command = 'opencode';
  installCommand = 'npm install -g opencode-ai';
  updateCommand = 'npm install -g opencode-ai@latest';
  npmPackageName = 'opencode-ai';

  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(getOpenCodeConfigFile());
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    return isQiniuBaseUrl(getPath(this.getConfig(), `provider.${PROVIDER_ID}.options.baseURL`));
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const file = getOpenCodeConfigFile();
    const config = readJsonObjectStrict(file);
    if (!stateStore.getPriors(this.name)) {
      const legacy = isRecord(config.provider) && PROVIDER_ID in config.provider;
      stateStore.recordPriors(this.name, {
        model: legacy ? null : config.model ?? null,
        $schema: config.$schema ?? null,
      });
    }
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    writeJson(file, applyOpenCodeConfig(config, baseUrl, apiKey, model, limits));
  }

  unloadConfig(): void {
    const file = getOpenCodeConfigFile();
    const config = readJsonObjectStrict(file);
    if (!stateStore.getPriors(this.name) && !this.isConfigured()) return;
    writeJsonOrRemove(file, revertOpenCodeConfig(config, stateStore.getPriors(this.name) ?? {}));
    // 还原后清除原值记录：之后用户可能自己改配置，下次装载需重新记录
    stateStore.markRemoved(this.name);
  }
}

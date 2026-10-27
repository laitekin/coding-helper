import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { assertNotSymlink, readTextFile, readJsonObjectStrict, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  OpenAICompatTool,
  type ModelLimits,
  fetchModelLimits,
  getPath,
  isRecord,
  openAIBaseUrl,
  restorePath,
} from './openai-compat-tool.js';

const PROVIDER_ID = 'qiniu';

// OpenCode 后加载 JSONC；优先操作生效的文件（含注释时拒绝覆盖）
export function getOpenCodeConfigFile(home = os.homedir()): string {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  return fs.existsSync(jsonc) ? jsonc : json;
}

// 写入七牛 provider 并设为默认模型，其他 provider 与设置原样保留
export function applyOpenCodeConfig(
  config: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  model: string,
  limits?: ModelLimits,
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
        ...(limits?.modalities ? { modalities: limits.modalities } : {}),
        ...(limits ? { limit: { context: limits.contextWindow, output: limits.maxOutputTokens } } : {}),
      },
    },
  };
  next.provider = providers;
  next.model = `${PROVIDER_ID}/${model}`;
  return next;
}

// 按原值还原 provider 和默认模型
export function revertOpenCodeConfig(config: Record<string, unknown>, priors: PriorValues): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  if (isRecord(next.provider)) next.provider = { ...next.provider };
  restorePath(next, `provider.${PROVIDER_ID}`, priors[`provider.${PROVIDER_ID}`]);
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
    assertNotSymlink(file);
    readJsonObjectStrict(file);
    const before = readTextFile(file);
    // JSON 中的 provider 过滤也会影响后加载的 JSONC
    const lowerFile = file.endsWith('.jsonc') ? path.join(path.dirname(file), 'opencode.json') : undefined;
    const lowerBefore = lowerFile ? readTextFile(lowerFile) : undefined;
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    assertNotSymlink(file);
    const config = readJsonObjectStrict(file);
    if (getOpenCodeConfigFile() !== file || readTextFile(file) !== before ||
        (lowerFile && readTextFile(lowerFile) !== lowerBefore)) {
      throw new Error('OpenCode configuration changed while fetching model metadata. Retry with the current configuration.');
    }
    const lowerConfig = lowerFile ? readJsonObjectStrict(lowerFile) : {};
    const effective = { ...lowerConfig, ...config };
    if ((Array.isArray(effective.enabled_providers) && !effective.enabled_providers.includes(PROVIDER_ID)) ||
        (Array.isArray(effective.disabled_providers) && effective.disabled_providers.includes(PROVIDER_ID))) {
      throw new Error('OpenCode provider filters exclude qiniu. Update enabled_providers/disabled_providers before loading.');
    }
    const hadPriors = stateStore.getPriors(this.name, file) !== undefined;
    if (!hadPriors) {
      stateStore.recordPriors(this.name, {
        model: config.model ?? null,
        $schema: config.$schema ?? null,
        ['provider.' + PROVIDER_ID]: getPath(config, 'provider.' + PROVIDER_ID) ?? null,
      }, file);
    }
    try {
      writeJson(file, applyOpenCodeConfig(config, baseUrl, apiKey, model, limits));
    } catch (err) {
      // 未成功装载时撤销本轮新建的原值，已有成功装载的状态不能清除
      if (!hadPriors) stateStore.markRemoved(this.name, file);
      throw err;
    }
  }

  unloadConfig(): void {
    const file = getOpenCodeConfigFile();
    assertNotSymlink(file);
    const config = readJsonObjectStrict(file);
    const priors = stateStore.getPriors(this.name, file);
    if (!priors && !this.isConfigured()) return;
    writeJsonOrRemove(file, revertOpenCodeConfig(config, priors ?? {}));
    // 还原后清除原值记录：之后用户可能自己改配置，下次装载需重新记录
    stateStore.markRemoved(this.name, file);
  }
}

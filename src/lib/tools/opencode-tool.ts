import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { assertNotSymlink, readTextFile, readJsonSnapshot, readJsonObjectStrict, writeJson, writeJsonOrRemove } from '../core/safe-write.js';
import { stateStore, type PriorValues } from '../core/state-store.js';
import {
  OpenAICompatTool,
  type ModelLimits,
  fetchModelLimits,
  getPath,
  isRecord,
  openAIBaseUrl,
} from './openai-compat-tool.js';

const PROVIDER_ID = 'qiniu';

// OpenCode 后加载 JSONC；优先操作生效的文件（含注释时拒绝覆盖）
function getOpenCodeConfigFiles(home = os.homedir()): [string, string] {
  const dir = canonicalDirectory(path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'));
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
}

export function getOpenCodeConfigFile(home = os.homedir()): string {
  const [json, jsonc] = getOpenCodeConfigFiles(home);
  try { fs.lstatSync(jsonc); return jsonc; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return json;
  }
}

// 只解析父目录：目录别名使用同一状态身份，文件本身的符号链接仍明确拒绝
function canonicalDirectory(dir: string): string {
  try { return fs.realpathSync(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(dir) === dir) throw err;
    return path.join(canonicalDirectory(path.dirname(dir)), path.basename(dir));
  }
}

function validateConfig(config: Record<string, unknown>): void {
  for (const key of ['enabled_providers', 'disabled_providers']) {
    if (Object.hasOwn(config, key) && (!Array.isArray(config[key]) || !(config[key] as unknown[]).every((value) => typeof value === 'string'))) {
      throw new Error('Invalid OpenCode ' + key + ': expected a string array.');
    }
  }
  if (Object.hasOwn(config, 'provider') && !isRecord(config.provider)) throw new Error('Invalid OpenCode provider object.');
  const provider = getPath(config, 'provider.qiniu');
  if (provider !== undefined && !isRecord(provider)) throw new Error('Invalid OpenCode qiniu provider object.');
  if (isRecord(provider)) {
    for (const key of ['whitelist', 'blacklist']) {
      if (Object.hasOwn(provider, key) && (!Array.isArray(provider[key]) || !(provider[key] as unknown[]).every((value) => typeof value === 'string'))) {
        throw new Error('Invalid OpenCode qiniu ' + key + ': expected a string array.');
      }
    }
    for (const key of ['options', 'models']) {
      if (Object.hasOwn(provider, key) && !isRecord(provider[key])) throw new Error('Invalid OpenCode qiniu ' + key + ' object.');
    }
  }
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
  const previous = isRecord(providers[PROVIDER_ID]) ? providers[PROVIDER_ID] : {};
  providers[PROVIDER_ID] = {
    ...previous,
    npm: '@ai-sdk/openai-compatible',
    name: 'Qiniu',
    options: { ...(isRecord(previous.options) ? previous.options : {}), baseURL: openAIBaseUrl(baseUrl), apiKey },
    models: {
      ...(isRecord(previous.models) ? previous.models : {}),
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

// 只记录实际管理的字段，缺失与 null 区分，避免删除用户原有空值
function snapshot(config: Record<string, unknown>): PriorValues {
  const result: PriorValues = {};
  for (const key of ['model', '$schema']) {
    if (Object.hasOwn(config, key)) result[key] = config[key];
  }
  if (isRecord(config.provider) && Object.hasOwn(config.provider, PROVIDER_ID)) {
    result.provider = config.provider[PROVIDER_ID];
  }
  return result;
}

// 三方还原：只撤销仍与本工具最后写入值相同的字段，保留之后的用户修改
function restoreValue(current: unknown, prior: unknown, applied: unknown): unknown {
  if (isDeepStrictEqual(current, applied)) return prior;
  if (!isRecord(current) || !isRecord(applied) || (prior !== undefined && !isRecord(prior))) return current;
  const original = isRecord(prior) ? prior : {};
  const next = { ...current };
  for (const key of new Set([...Object.keys(original), ...Object.keys(applied)])) {
    const own = (value: Record<string, unknown>): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
    const restored = restoreValue(own(current), own(original), own(applied));
    if (restored === undefined) delete next[key];
    else Object.defineProperty(next, key, { value: restored, enumerable: true, writable: true, configurable: true });
  }
  return prior === undefined && Object.keys(next).length === 0 ? undefined : next;
}

export function revertOpenCodeConfig(config: Record<string, unknown>, priors: PriorValues, applied: PriorValues): Record<string, unknown> {
  const next = { ...config };
  const current = snapshot(config);
  for (const key of ['model', '$schema', 'provider']) {
    const original = Object.hasOwn(priors, key) ? priors[key] : undefined;
    const written = Object.hasOwn(applied, key) ? applied[key] : undefined;
    const value = restoreValue(current[key], original, written);
    if (key === 'provider') {
      if (!isRecord(config.provider)) continue;
      const providers = { ...config.provider };
      if (value === undefined) delete providers[PROVIDER_ID];
      else providers[PROVIDER_ID] = value;
      if (Object.keys(providers).length) next.provider = providers;
      else delete next.provider;
    } else if (value === undefined) delete next[key];
    else next[key] = value;
  }
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
    const { content: before } = readJsonSnapshot(file);
    // JSON 中的 provider 过滤也会影响后加载的 JSONC
    const lowerFile = file.endsWith('.jsonc') ? path.join(path.dirname(file), 'opencode.json') : undefined;
    const lowerBefore = lowerFile ? readTextFile(lowerFile) : undefined;
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    assertNotSymlink(file);
    const { value: config, content: current } = readJsonSnapshot(file);
    if (current !== before || getOpenCodeConfigFile() !== file || readTextFile(file) !== before ||
        (lowerFile && readTextFile(lowerFile) !== lowerBefore)) {
      throw new Error('OpenCode configuration changed while fetching model metadata. Retry with the current configuration.');
    }
    const lowerConfig = lowerFile ? readJsonObjectStrict(lowerFile) : {};
    validateConfig(config);
    validateConfig(lowerConfig);
    const effective = { ...lowerConfig, ...config };
    if ((Array.isArray(effective.enabled_providers) && !effective.enabled_providers.includes(PROVIDER_ID)) ||
        (Array.isArray(effective.disabled_providers) && effective.disabled_providers.includes(PROVIDER_ID))) {
      throw new Error('OpenCode provider filters exclude qiniu. Update enabled_providers/disabled_providers before loading.');
    }
    const lowerProvider = getPath(lowerConfig, 'provider.qiniu');
    const upperProvider = getPath(config, 'provider.qiniu');
    const effectiveProvider = { ...(isRecord(lowerProvider) ? lowerProvider : {}), ...(isRecord(upperProvider) ? upperProvider : {}) };
    if ((Array.isArray(effectiveProvider.whitelist) && !effectiveProvider.whitelist.includes(model)) ||
        (Array.isArray(effectiveProvider.blacklist) && effectiveProvider.blacklist.includes(model))) {
      throw new Error('OpenCode model filters exclude ' + model + '. Update qiniu whitelist/blacklist before loading.');
    }
    stateStore.withLock(() => {
      // JSON/JSONC 优先级切换不能留下两个独立的托管配置，先还原原文件
      const otherManaged = getOpenCodeConfigFiles().find((candidate) => candidate !== file && stateStore.getState(this.name, candidate));
      if (otherManaged) throw new Error('Unload the existing managed configuration before switching files: ' + otherManaged);
      const previous = stateStore.getState(this.name, file);
      if (previous && (!isRecord(previous.priors?.snapshot) || !isRecord(previous.applied))) {
        throw new Error('OpenCode restoration state lacks a managed snapshot. Restore from backup before reconfiguring.');
      }
      if (previous?.applied && !isDeepStrictEqual(snapshot(config), previous.applied)) {
        throw new Error('OpenCode managed fields changed since loading. Unload first to preserve your changes, then reload.');
      }
      if (readTextFile(file) !== before) throw new Error('OpenCode configuration changed before writing. Retry.');
      const next = applyOpenCodeConfig(config, baseUrl, apiKey, model, limits);
      const priors = previous?.priors ?? { snapshot: snapshot(config), fileExisted: before !== undefined, providerExisted: Object.hasOwn(config, 'provider') };
      stateStore.setState(this.name, { priors, applied: snapshot(next) }, file);
      try {
        writeJson(file, next, { content: before });
      } catch (err) {
        // 写入未提交：完整回滚本轮状态；失败会明确报错，不伪装成装载成功
        stateStore.setState(this.name, previous, file);
        throw err;
      }
    });
  }

  unloadConfig(): void {
    stateStore.withLock(() => {
      // 按已记录的装载目标卸载，后来新增 JSONC 不应让旧 JSON 的凭据遗留
      const managed = getOpenCodeConfigFiles().filter((candidate) => stateStore.getState(this.name, candidate));
      if (managed.length > 1) throw new Error('Multiple managed OpenCode configurations found. Restore them from backup before unloading.');
      const file = managed[0] ?? getOpenCodeConfigFile();
      const saved = stateStore.getState(this.name, file);
      assertNotSymlink(file);
      const { value: config, content: before } = readJsonSnapshot(file);
      // 域名相同不意味着用户配置归本工具所有；没有记录就不删除
      if (!saved) return;
      if (!isRecord(saved.priors?.snapshot) || !isRecord(saved.applied)) {
        throw new Error('OpenCode restoration state lacks a managed snapshot. Restore from backup before unloading.');
      }
      const next = revertOpenCodeConfig(config, saved.priors.snapshot, saved.applied);
      if (saved.priors.providerExisted && isRecord(config.provider) && !Object.hasOwn(next, 'provider')) next.provider = {};
      // 已有的空文件对象保留，只有本工具新建且还原为空的文件才移除
      if (before !== undefined) {
        if (saved.priors.fileExisted) writeJson(file, next, { content: before });
        else writeJsonOrRemove(file, next, { content: before });
      }
      stateStore.markRemoved(this.name, file);
    });
  }
}

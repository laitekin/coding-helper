import { execSync } from 'node:child_process';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { marketModelService } from '../market-model-service.js';
import { getModelCapabilities } from '../market-model-service.js';
import { t } from '../i18n.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';
import { promptHelper } from '../wizard/ui/prompt-helper.js';
import { runGenericModelSelectionFlow } from '../wizard/flows/generic-model-selection-flow.js';

// 七牛 OpenAI 兼容接口地址
export function openAIBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1`;
}

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

const FALLBACK_LIMITS: ModelLimits = { contextWindow: 128000, maxOutputTokens: 8192 };

// 尽力从模型市场获取上下文与输出上限，失败时使用保守的默认值
export async function fetchModelLimits(baseUrl: string, apiKey: string, model: string): Promise<ModelLimits> {
  try {
    const models = await marketModelService.fetchModels(baseUrl.replace(/\/+$/, ''), apiKey);
    const info = models.find((m) => m.id === model);
    if (!info) return FALLBACK_LIMITS;
    const caps = getModelCapabilities(info);
    return { contextWindow: caps.maxInputTokens, maxOutputTokens: caps.maxOutputTokens };
  } catch {
    return FALLBACK_LIMITS;
  }
}

// 通用 OpenAI 兼容客户端的公共部分：命令检测、模型选择与展示
export abstract class OpenAICompatTool implements ITool {
  abstract name: string;
  abstract displayName: string;
  abstract command: string;
  abstract installCommand: string;
  aliases?: string[];
  updateCommand?: string;
  npmPackageName?: string;
  requiresModelSelection = true;

  isInstalled(): boolean {
    try {
      execSync(process.platform === 'win32' ? `where ${this.command}` : `which ${this.command}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  getVersion(): string | null {
    try {
      const output = execSync(`${this.command} --version`, { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : output;
    } catch {
      return null;
    }
  }

  // 本工具使用的模型：单独选择过的优先，否则用通用默认模型
  protected resolveModel(models: ModelConfig): string {
    const model = models.toolModels?.[this.name] ?? models.defaultModel;
    if (!model) throw new Error(t('generic_model_not_configured', { tool: this.displayName }));
    return model;
  }

  async runModelConfigFlow(): Promise<boolean> {
    const selected = await runGenericModelSelectionFlow(this.name, this.displayName);
    if (!selected) return false;
    uiRenderer.renderHeader();
    uiRenderer.renderSuccess(t('generic_config_success', { tool: this.displayName, model: selected }));
    await promptHelper.pressEnter();
    return true;
  }

  renderModelConfigSummary(): void {
    const models = configManager.getModels();
    uiRenderer.renderModelConfigItem(t('config_view_model'), models.toolModels?.[this.name] ?? models.defaultModel);
  }

  clearModelConfig(): void {
    void this.unloadConfig();
  }

  abstract getConfig(): Record<string, unknown>;
  abstract isConfigured(): boolean;
  abstract loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void>;
  abstract unloadConfig(): void | Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 按点分路径读取嵌套值
export function getPath(target: Record<string, unknown>, keyPath: string): unknown {
  let current: unknown = target;
  for (const key of keyPath.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

// 按点分路径写入嵌套值，中间对象不存在时创建
export function setPath(target: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

// 按原值还原：null/undefined 时删除，并清理因此变空的中间对象
export function restorePath(target: Record<string, unknown>, keyPath: string, prior: unknown): void {
  if (prior !== null && prior !== undefined) {
    setPath(target, keyPath, prior);
    return;
  }
  const keys = keyPath.split('.');
  const chain: Record<string, unknown>[] = [target];
  for (const key of keys.slice(0, -1)) {
    const next = chain[chain.length - 1][key];
    if (!isRecord(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][keys[keys.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][keys[i - 1]];
  }
}

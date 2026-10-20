import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { ConfigParseError, backupFile, isDryRun, readTextFile, safeWriteFile } from '../core/safe-write.js';
import { OpenAICompatTool, fetchModelLimits, getPath, isRecord, openAIBaseUrl } from './openai-compat-tool.js';

const PROVIDER_ID = 'qiniu';
// mcode provider add 从这个环境变量读取 Key 并写入配置
const KEY_ENV = 'QINIU_API_KEY';

export function getMinimaxConfigFile(): string {
  const dir = process.env.MINIMAX_DATA_DIR || process.env.MAVIS_DATA_DIR || path.join(os.homedir(), '.minimax');
  return path.join(dir, 'config.yaml');
}

// 移除 custom_provider.qiniu，其他 provider 与设置原样保留
export function removeMinimaxProvider(content: string): string {
  const config = yaml.load(content);
  if (!isRecord(config) || !isRecord(config.custom_provider)) return content;
  delete config.custom_provider[PROVIDER_ID];
  if (Object.keys(config.custom_provider).length === 0) delete config.custom_provider;
  return Object.keys(config).length > 0 ? yaml.dump(config, { lineWidth: -1, noRefs: true }) : '';
}

// MiniMax Code（mcode）：配置结构未公开，通过官方的 mcode provider add 写入（含连通性测试）
export class MinimaxCodeTool extends OpenAICompatTool {
  name = 'minimax-code';
  displayName = 'MiniMax Code';
  command = 'mcode';
  installCommand = 'npm install -g @minimax-ai/code@latest';
  updateCommand = 'npm install -g @minimax-ai/code@latest';
  npmPackageName = '@minimax-ai/code';
  aliases = ['mcode', 'minimax'];

  getConfig(): Record<string, unknown> {
    try {
      const parsed = yaml.load(readTextFile(getMinimaxConfigFile()) ?? '');
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  isConfigured(): boolean {
    return isQiniuBaseUrl(getPath(this.getConfig(), `custom_provider.${PROVIDER_ID}.options.baseURL`));
  }

  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    if (isDryRun()) return;
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    backupFile(getMinimaxConfigFile());
    try {
      execFileSync(this.command, [
        'provider', 'add',
        '--name', PROVIDER_ID,
        '--base-url', openAIBaseUrl(baseUrl),
        '--api-format', 'openai-completions',
        '--model', model,
        '--api-key-env', KEY_ENV,
        '--context-limit', String(limits.contextWindow),
        '--output-limit', String(limits.maxOutputTokens),
        '--use',
      ], {
        env: { ...process.env, [KEY_ENV]: apiKey },
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 90000,
        shell: process.platform === 'win32',
      });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr?.trim().split('\n').slice(-2).join(' ');
      throw new Error(t('minimax_provider_add_failed', { error: stderr || (err instanceof Error ? err.message : String(err)) }));
    }
  }

  // 没有官方的删除命令：直接从 config.yaml 删除 custom_provider.qiniu（原文件已备份）
  unloadConfig(): void {
    const file = getMinimaxConfigFile();
    if (!fs.existsSync(file) || !this.isConfigured()) return;
    const content = readTextFile(file) ?? '';
    try {
      safeWriteFile(file, removeMinimaxProvider(content));
    } catch (err) {
      throw new ConfigParseError(file, err);
    }
  }
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { readTextFile, assertNotSymlink } from '../core/safe-write.js';
import { applyConfigEdits, restoreConfigEdits } from '../core/config-transaction.js';
import { parseYamlDocument } from '../core/yaml-edit.js';
import { OpenAICompatTool, fetchModelLimits, isRecord, openAIBaseUrl } from './openai-compat-tool.js';

export function getMinimaxConfigFile(): string {
  return path.join(process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim() || path.join(os.homedir(), '.minimax'), 'config.yaml');
}

export class MinimaxCodeTool extends OpenAICompatTool {
  name = 'minimax-code';
  displayName = 'MiniMax Code';
  command = 'mcode';
  installCommand = 'npm install -g @minimax-ai/code@latest';
  updateCommand = 'npm install -g @minimax-ai/code@latest';
  npmPackageName = '@minimax-ai/code';
  aliases = ['mcode', 'minimax'];
  getConfig(): Record<string, unknown> {
    try { return parseYamlDocument(readTextFile(getMinimaxConfigFile()) ?? '').toJS() as Record<string, unknown>; }
    catch { return {}; }
  }
  isConfigured(): boolean {
    const config = this.getConfig();
    return isRecord(config.custom_provider) && Object.hasOwn(config.custom_provider, 'qiniu');
  }
  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    const model = this.resolveModel(models);
    const file = getMinimaxConfigFile();
    assertNotSymlink(file);
    const before = readTextFile(file);
    const staged = parseYamlDocument(before ?? '');
    // provider add generates qiniu-2 when qiniu already exists. Replace only in staging.
    staged.deleteIn(['custom_provider', 'qiniu']);
    if (/^(?:custom_provider:)?qiniu\//.test(String(staged.get('defaultModel') ?? ''))) staged.delete('defaultModel');
    const limits = await fetchModelLimits(baseUrl, apiKey, model);
    // 官方命令只写临时数据目录，成功并校验后才替换用户文件
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-mcode-'));
    try {
      fs.writeFileSync(path.join(stage, 'config.yaml'), String(staged), { mode: 0o600 });
      try {
        execFileSync(this.command, ['provider', 'add', '--name', 'qiniu', '--base-url', openAIBaseUrl(baseUrl),
          '--api-format', 'openai-completions', '--model', model, '--api-key-env', 'QINIU_API_KEY',
          '--context-limit', String(limits.contextWindow), '--output-limit', String(limits.maxOutputTokens), '--use'], {
          env: { ...process.env, MINIMAX_DATA_DIR: stage, MAVIS_DATA_DIR: stage, QINIU_API_KEY: apiKey },
          stdio: 'pipe', encoding: 'utf8', timeout: 90000,
        });
      } catch {
        // 不转发子进程原始输出，避免命令错误信息泄露 Key
        throw new Error(t('minimax_provider_add_failed', { error: 'provider command failed; original configuration was not changed' }));
      }
      assertNotSymlink(path.join(stage, 'config.yaml'));
      const after = readTextFile(path.join(stage, 'config.yaml'));
      if (after === undefined) throw new Error('MiniMax did not create its staged configuration.');
      const config = parseYamlDocument(after).toJS() as Record<string, unknown>;
      const provider = isRecord(config.custom_provider) ? config.custom_provider.qiniu : undefined;
      if (!isRecord(provider) || !isRecord(provider.options) || provider.options.baseURL !== openAIBaseUrl(baseUrl) ||
          provider.options.apiKey !== apiKey.trim() || provider.api !== 'openai-completions' ||
          !isRecord(provider.models) || !Object.hasOwn(provider.models, model)) throw new Error('MiniMax staged provider does not match the requested configuration.');
      if (!isRecord(config.custom_provider) || !Object.hasOwn(config.custom_provider, 'qiniu') ||
          !['qiniu/' + model, 'custom_provider:qiniu/' + model].includes(String(config.defaultModel))) {
        throw new Error('MiniMax staged provider or default model is missing.');
      }
      applyConfigEdits(this.name, [{ file, build: current => {
        if (current !== before) throw new Error('MiniMax configuration changed during provider setup. Retry.');
        return after;
      } }]);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  unloadConfig(): void { restoreConfigEdits(this.name, [getMinimaxConfigFile()]); }
}

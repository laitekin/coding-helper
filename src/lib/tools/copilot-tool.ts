import type { ModelConfig } from '../config.js';
import os from 'node:os';
import path from 'node:path';
import { readJsonObjectStrict } from '../core/safe-write.js';
import { t } from '../i18n.js';
import { OpenAICompatTool, openAIBaseUrl } from './openai-compat-tool.js';

// 仅走 run 启动器；持久 provider 注册表会覆盖环境配置，存在时明确拒绝。
export class CopilotTool extends OpenAICompatTool {
  name = 'copilot';
  displayName = 'GitHub Copilot CLI';
  command = 'copilot';
  installCommand = 'npm install -g @github/copilot';
  updateCommand = 'npm install -g @github/copilot@latest';
  npmPackageName = '@github/copilot';
  launchOnly = true;

  getConfig(): Record<string, unknown> {
    return {};
  }

  isConfigured(): boolean {
    return false;
  }

  async loadConfig(): Promise<void> {
    throw new Error(t('setup_reason_launch_only'));
  }

  unloadConfig(): void {
    // 没有写入任何文件，无需还原
  }

  getLaunchEnv(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string | undefined> {
    const file = process.env.COPILOT_PROVIDERS_CONFIG || path.join(os.homedir(), '.copilot', 'providers.json');
    const registry = readJsonObjectStrict(file);
    if (Object.keys(registry).length) throw new Error('Copilot provider registry takes precedence over launcher settings. Use a separate empty COPILOT_PROVIDERS_CONFIG file before launching.');
    return {
      COPILOT_PROVIDER_API_KEY_COMMAND: undefined,
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: openAIBaseUrl(baseUrl),
      COPILOT_PROVIDER_API_KEY: apiKey,
      COPILOT_MODEL: this.resolveModel(models),
    };
  }
}
